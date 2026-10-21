/* lib/spacetrack.ts — Space-Track client hygiene, fully offline.
   fetch is replaced by an in-memory fake of the two endpoints the lib uses
   (POST /ajaxauth/login, GET /basicspacedata/query/...), so these tests
   prove the rate-limit behaviour without credentials or network:
   one shared login, shared dataset caches with in-flight dedupe, the
   401 re-login + single retry, the 15 s timeout, and request accounting. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ST from "@/lib/spacetrack";

process.env.SPACETRACK_USERNAME = "test-user";
process.env.SPACETRACK_PASSWORD = "test-password";

interface Call {
  url: string;
  method: string;
  cookie: string | null;
  hasSignal: boolean;
}
const calls: Call[] = [];
let loginCount = 0;
let queryCount = 0;
let failNext401 = false;
let timeoutNext = false;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const limitOf = (url: string): number => Number(/limit\/(\d+)/.exec(url)?.[1] ?? "0");

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  calls.push({ url, method: init?.method ?? "GET", cookie: headers.get("Cookie"), hasSignal: init?.signal != null });

  if (url.includes("/ajaxauth/login")) {
    loginCount++;
    await delay(30);
    return new Response("", { status: 200, headers: { "set-cookie": `chocolatechip=abc${loginCount}; Path=/; HttpOnly` } });
  }
  queryCount++;
  if (timeoutNext) {
    timeoutNext = false;
    assert.ok(init?.signal, "every query must carry an abort signal");
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  }
  if (failNext401) {
    failNext401 = false;
    return new Response("", { status: 401 });
  }
  await delay(20);
  if (url.includes("class/gp/")) {
    const rows = Array.from({ length: Math.min(limitOf(url), 2000) }, (_, i) => ({ NORAD_CAT_ID: String(i), TLE_LINE1: "", TLE_LINE2: "" }));
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  if (url.includes("class/cdm_public/")) {
    const rows = Array.from({ length: limitOf(url) }, (_, i) => ({ CDM_ID: String(i), TCA: `t${i}` }));
    return new Response(JSON.stringify(rows), { status: 200 });
  }
  return new Response("[]", { status: 404 });
}) as typeof fetch;

test("cold start: 4 concurrent callers share ONE login and one download per dataset", async () => {
  const [a, b, c, d] = await Promise.all([
    ST.fetchTLEs(2000),
    ST.fetchTLEs(2000),
    ST.fetchConjunctions(10),
    ST.fetchConjunctions(25),
  ]);
  assert.equal(loginCount, 1, "one login for four cold callers");
  assert.equal(queryCount, 2, "one gp download + one cdm_public download");
  assert.equal(a, b, "TLE callers receive the same cached array");
  assert.equal(a.length, 2000);
  assert.equal(c.length, 10);
  assert.equal(d.length, 25);
  assert.ok(calls.some((k) => k.url.includes("cdm_public") && k.url.includes("limit/100")), "CDMs come from one shared pull of 100");
});

test("session cookie is parsed as setCookie.split(';')[0] and sent on queries", () => {
  const login = calls.find((k) => k.url.includes("/ajaxauth/login"));
  assert.ok(login);
  assert.equal(login.method, "POST");
  const queries = calls.filter((k) => k.url.includes("/basicspacedata/query/"));
  assert.ok(queries.length > 0);
  for (const q of queries) assert.equal(q.cookie, "chocolatechip=abc1");
  assert.ok(calls.every((k) => k.hasSignal), "every request carries a timeout signal");
});

test("cache: repeat calls are served from memory; a different limit is its own key", async () => {
  const e = await ST.fetchConjunctions(100);
  assert.equal(e.length, 100);
  assert.equal(queryCount, 2, "CDM limit 100 served from the shared pull");
  await ST.fetchTLEs(1);
  assert.equal(queryCount, 3, "gp:1 is a separate cache key");
  const capped = await ST.fetchConjunctions(500);
  assert.equal(capped.length, 100, "CDM limit is capped at the shared pull size");
  assert.equal(queryCount, 3);
});

test("401: one forced re-login, then exactly one retry", async () => {
  ST.clearSpaceTrackCaches();
  failNext401 = true;
  const loginsBefore = loginCount;
  const queriesBefore = queryCount;
  const rows = await ST.fetchTLEs(300);
  assert.equal(rows.length, 300);
  assert.equal(loginCount, loginsBefore + 1);
  assert.equal(queryCount, queriesBefore + 2, "the failed query plus one retry");
});

test("timeout: mapped to a clear error and never cached", async () => {
  ST.clearSpaceTrackCaches();
  timeoutNext = true;
  await assert.rejects(ST.fetchTLEs(500), /timed out after 15s/);
  const retry = await ST.fetchTLEs(500);
  assert.equal(retry.length, 500, "the next caller retries and succeeds");
});

test("searchTLE: numeric queries use NORAD_CAT_ID, names use OBJECT_NAME, blank returns null", async () => {
  const hit = await ST.searchTLE("25544");
  assert.ok(hit);
  assert.ok(calls.some((k) => k.url.includes("NORAD_CAT_ID/25544")));
  await ST.searchTLE("HUBBLE");
  assert.ok(calls.some((k) => k.url.includes("OBJECT_NAME/~~HUBBLE")));
  assert.equal(await ST.searchTLE("   "), null);
});

test("searchTLE: bare \"ISS\" is aliased to NORAD 25544 and shares its 5-min lookup cache", async () => {
  // OBJECT_NAME/~~ISS would return whichever "ISS…" object (NAUKA, an ISS DEB
  // fragment, SWISSCUBE) has the newest epoch — the routes that resolve a user
  // query must all mean the same object, and must not re-query Space-Track.
  const direct = await ST.searchTLE("25544");
  const before = calls.length;
  const aliased = await ST.searchTLE(" iss ");
  assert.deepEqual(aliased, direct);
  assert.equal(calls.length, before, "served from the shared search cache — no HTTP call");
  assert.ok(!calls.some((k) => k.url.toLowerCase().includes("object_name/~~iss")));
});

test("request accounting: every HTTP call is counted against the published budget", () => {
  const stats = ST.getSpaceTrackStats();
  assert.equal(stats.requestsLastHour, calls.length, "logins + queries are all counted");
  assert.equal(stats.requestsLastMinute, calls.length, "the whole suite runs inside one minute");
  assert.equal(stats.hourlyLimit, 300);
  assert.equal(stats.perMinuteLimit, 30);
  assert.equal(ST.SPACE_TRACK_HOURLY_LIMIT, 300);
  assert.equal(ST.SPACE_TRACK_PER_MINUTE_LIMIT, 30);
  assert.ok(stats.lastLoginAt !== null && Number.isFinite(Date.parse(stats.lastLoginAt)));
  assert.ok(stats.sessionCookieAgeSeconds !== null && stats.sessionCookieAgeSeconds >= 0);
  assert.ok(stats.sharedCacheHits > 0, "dedupe and cache hits are recorded");
  assert.ok(stats.sharedCacheMisses > 0);
  assert.ok(stats.sharedCacheEntries >= 1);
});

test("missing credentials fail loudly instead of sending an empty login", async () => {
  ST.clearSpaceTrackCaches();
  // Force a fresh login path: a 401 drops the cached cookie.
  failNext401 = true;
  delete process.env.SPACETRACK_PASSWORD;
  await assert.rejects(ST.fetchTLEs(42), /SPACETRACK_USERNAME \/ SPACETRACK_PASSWORD are not set/);
  process.env.SPACETRACK_PASSWORD = "test-password";
});

test("soft budget: the request that would exceed 25/min is refused locally, before any HTTP call", async () => {
  // Runs last: it fills the per-instance request log up to the soft limit.
  while (ST.getSpaceTrackStats().requestsLastMinute < ST.SPACE_TRACK_SOFT_PER_MINUTE_LIMIT) {
    await ST.probeGp(); // uncached by design — one HTTP call each
  }
  assert.equal(ST.getSpaceTrackStats().requestsLastMinute, ST.SPACE_TRACK_SOFT_PER_MINUTE_LIMIT);
  const before = calls.length;
  await assert.rejects(ST.probeGp(), (err: unknown) => {
    assert.ok(err instanceof ST.SpaceTrackBudgetError);
    assert.equal(err.name, "SpaceTrackBudgetError");
    assert.match(err.message, /budget exhausted on this instance/);
    assert.ok(err.retryAfterSeconds >= 1 && err.retryAfterSeconds <= 60);
    return true;
  });
  assert.equal(calls.length, before, "refused without touching Space-Track");
  const stats = ST.getSpaceTrackStats();
  assert.equal(stats.budgetRefusals, 1);
  assert.ok(stats.softPerMinuteLimit < ST.SPACE_TRACK_PER_MINUTE_LIMIT && stats.softHourlyLimit < ST.SPACE_TRACK_HOURLY_LIMIT);
});
