/* ============================================================
   SpaceDebris — Space-Track.org API client

   Handles:
   - Session-cookie authentication (POST /ajaxauth/login).
   - Cookie caching for 50 minutes (CONTEXT.md line 194).
   - Automatic re-login + single retry on 401 (Gotcha #1).
   - Typed fetches for TLEs (orbital map + risk scorer) and
     CDM conjunctions (alert feed).

   Credentials come from env only (Workflow Rule #9):
     SPACETRACK_USERNAME, SPACETRACK_PASSWORD

   IMPORTANT: routes that import this MUST run on the Node.js
   runtime (export const runtime = "nodejs"), not Edge — this
   relies on cookies and longer-lived requests.

   Session 5 additions (rate-limit hygiene — the page now has
   eleven routes, several of which pull the SAME datasets):
   - ONE login at a time: concurrent callers on a cold instance
     share a single in-flight login promise instead of each
     logging in (fleet / iss / screen / debris all fire together
     on page load).
   - Shared dataset caches with in-flight dedupe, keyed by query:
       fetchTLEs(limit)        -> "gp:<limit>", TTL 10 min
       fetchConjunctions(...)  -> one cdm_public pull of
                                  CDM_SHARED_LIMIT rows, TTL 60 s,
                                  sliced per caller
     so /api/debris, /api/fleet and /api/screen share one 2,000-row
     download, and /api/conjunctions, /api/fleet and /api/iss share
     one CDM download. Route-level caches still sit on top.
   - 15 s fetch timeout on login and queries so a stalled
     Space-Track socket cannot pin a route to its maxDuration.
   Auth logic (cookie parse, 401 re-login + single retry) is
   unchanged.
   ============================================================ */

const BASE_URL = "https://www.space-track.org";
const LOGIN_URL = `${BASE_URL}/ajaxauth/login`;
const QUERY_BASE = `${BASE_URL}/basicspacedata/query`;

/** Session cookie is valid for ~1 hour; refresh after 50 minutes. */
const COOKIE_TTL_MS = 50 * 60 * 1000;

/** Abort any single Space-Track HTTP call after this long. */
const FETCH_TIMEOUT_MS = 15_000;

/** Shared gp (TLE) sample cache TTL — matches /api/debris. */
const TLE_CACHE_TTL_MS = 10 * 60 * 1000;
/** Shared cdm_public cache TTL — matches /api/conjunctions. */
const CDM_CACHE_TTL_MS = 60 * 1000;
/** All CDM consumers share ONE pull of this many soonest rows. */
const CDM_SHARED_LIMIT = 100;

/* ------------------------------------------------------------
   Response shapes — Space-Track returns every field as a STRING
   in JSON, so these are all typed as string (Workflow Rule #10).
   ------------------------------------------------------------ */

/** A row from the `gp` class (General Perturbations — current TLE source). */
export interface SpaceTrackTLE {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  NORAD_CAT_ID: string;
  EPOCH: string;
  TLE_LINE1: string;
  TLE_LINE2: string;
  INCLINATION: string;
  RA_OF_ASC_NODE: string;
  ECCENTRICITY: string;
  ARG_OF_PERICENTER: string;
  MEAN_ANOMALY: string;
  MEAN_MOTION: string;
  SEMIMAJOR_AXIS: string;
  PERIOD: string;
  APOAPSIS: string;
  PERIAPSIS: string;
}

/** A row from the `cdm_public` class (Conjunction Data Message). */
export interface SpaceTrackCDM {
  CDM_ID: string;
  CREATED: string;
  TCA: string;
  MIN_RNG: string;
  PC: string;
  SAT_1_ID: string;
  SAT_1_NAME: string;
  SAT_2_ID: string;
  SAT_2_NAME: string;
}

/* ------------------------------------------------------------
   Session cookie cache (module-scoped) + re-login on 401.
   ------------------------------------------------------------ */

let sessionCookie: string | null = null;
let cookieFetchedAt = 0;
/** Shared in-flight login so concurrent cold callers log in once. */
let loginInFlight: Promise<string> | null = null;

/* ------------------------------------------------------------
   Request accounting (Session 6 — System Telemetry panel).
   Every HTTP call to Space-Track (login + query) is timestamped so
   /api/health can report live budget use against the published
   30/min and 300/hr limits. Per serverless instance, like the caches.
   ------------------------------------------------------------ */

export const SPACE_TRACK_HOURLY_LIMIT = 300;
export const SPACE_TRACK_PER_MINUTE_LIMIT = 30;
const REQUEST_LOG_WINDOW_MS = 60 * 60 * 1000;
const requestLog: number[] = [];
let lastLoginAt: number | null = null;
let sharedCacheHits = 0;
let sharedCacheMisses = 0;

function recordRequest(): void {
  const now = Date.now();
  requestLog.push(now);
  while (requestLog.length > 0 && requestLog[0] < now - REQUEST_LOG_WINDOW_MS) {
    requestLog.shift();
  }
}

export interface SpaceTrackStats {
  requestsLastHour: number;
  requestsLastMinute: number;
  hourlyLimit: number;
  perMinuteLimit: number;
  lastLoginAt: string | null;
  sessionCookieAgeSeconds: number | null;
  sharedCacheEntries: number;
  sharedCacheHits: number;
  sharedCacheMisses: number;
}

/** Live Space-Track request budget for this instance (never throws). */
export function getSpaceTrackStats(): SpaceTrackStats {
  const now = Date.now();
  while (requestLog.length > 0 && requestLog[0] < now - REQUEST_LOG_WINDOW_MS) {
    requestLog.shift();
  }
  let lastMinute = 0;
  for (let i = requestLog.length - 1; i >= 0 && requestLog[i] >= now - 60_000; i--) {
    lastMinute++;
  }
  return {
    requestsLastHour: requestLog.length,
    requestsLastMinute: lastMinute,
    hourlyLimit: SPACE_TRACK_HOURLY_LIMIT,
    perMinuteLimit: SPACE_TRACK_PER_MINUTE_LIMIT,
    lastLoginAt: lastLoginAt === null ? null : new Date(lastLoginAt).toISOString(),
    sessionCookieAgeSeconds:
      sessionCookie && cookieFetchedAt > 0
        ? Math.round((now - cookieFetchedAt) / 1000)
        : null,
    sharedCacheEntries: sharedCache.size,
    sharedCacheHits,
    sharedCacheMisses,
  };
}

/** Read + validate credentials from the environment. */
function getCredentials(): { identity: string; password: string } {
  const identity = process.env.SPACETRACK_USERNAME;
  const password = process.env.SPACETRACK_PASSWORD;
  if (!identity || !password) {
    throw new Error(
      "SPACETRACK_USERNAME / SPACETRACK_PASSWORD are not set. Add them to .env.local (local) and to the Vercel dashboard (production)."
    );
  }
  return { identity, password };
}

/**
 * Log in to Space-Track and cache the session cookie.
 * Parses the cookie per Gotcha #1: setCookie.split(";")[0].
 */
async function login(): Promise<string> {
  const { identity, password } = getCredentials();

  const body = new URLSearchParams({ identity, password }).toString();

  const res = await fetchWithTimeout(LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(
      `Space-Track login failed: HTTP ${res.status} ${res.statusText}`
    );
  }

  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(
      "Space-Track login succeeded but no session cookie was returned. Check that the account is approved and credentials are correct."
    );
  }

  // "chocolatechip=...; Path=/; ..." -> keep only "chocolatechip=..."
  sessionCookie = setCookie.split(";")[0];
  cookieFetchedAt = Date.now();
  lastLoginAt = cookieFetchedAt;
  return sessionCookie;
}

/**
 * Return a valid session cookie, logging in if missing/expired.
 * Concurrent callers that all need a login share ONE in-flight
 * login promise (Session 5) — a cold serverless instance used to
 * perform one login per concurrent route on page load.
 */
async function getSessionCookie(forceRefresh = false): Promise<string> {
  const expired = Date.now() - cookieFetchedAt > COOKIE_TTL_MS;
  if (!forceRefresh && sessionCookie && !expired) {
    return sessionCookie;
  }
  if (!loginInFlight) {
    loginInFlight = login().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

/** fetch() with an absolute timeout; maps the abort to a clear error. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  recordRequest();
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(
        `Space-Track request timed out after ${FETCH_TIMEOUT_MS / 1000}s — ${url}`
      );
    }
    throw err;
  }
}

/* ------------------------------------------------------------
   Shared dataset cache (module-scoped, per serverless instance)
   with in-flight dedupe: N concurrent callers -> 1 request.
   Failures are never cached; the in-flight slot is cleared on
   rejection so the next caller retries.
   ------------------------------------------------------------ */

interface SharedCacheEntry<T> {
  data: T;
  expires: number;
}

const sharedCache = new Map<string, SharedCacheEntry<unknown>>();
const sharedInFlight = new Map<string, Promise<unknown>>();

async function sharedFetch<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>
): Promise<T> {
  const hit = sharedCache.get(key);
  if (hit && hit.expires > Date.now()) {
    sharedCacheHits++;
    return hit.data as T;
  }
  if (hit) sharedCache.delete(key);

  const pending = sharedInFlight.get(key);
  if (pending) {
    sharedCacheHits++;
    return pending as Promise<T>;
  }
  sharedCacheMisses++;

  const request = loader()
    .then((data) => {
      sharedCache.set(key, { data, expires: Date.now() + ttlMs });
      return data;
    })
    .finally(() => {
      if (sharedInFlight.get(key) === request) sharedInFlight.delete(key);
    });
  sharedInFlight.set(key, request);
  return request;
}

/** Test/ops hook: drop every shared dataset cache entry. */
export function clearSpaceTrackCaches(): void {
  sharedCache.clear();
  sharedInFlight.clear();
}

/**
 * GET a Space-Track query and parse JSON. On 401, null the cookie,
 * re-login, and retry exactly once (Gotcha #1).
 */
async function spaceTrackGet<T>(queryPath: string): Promise<T> {
  const url = `${QUERY_BASE}/${queryPath}`;

  const doRequest = async (cookie: string): Promise<Response> =>
    fetchWithTimeout(url, {
      method: "GET",
      headers: { Cookie: cookie },
      cache: "no-store",
    });

  let cookie = await getSessionCookie();
  let res = await doRequest(cookie);

  // 401 -> session likely expired/invalid. Force re-login and retry once.
  if (res.status === 401) {
    sessionCookie = null;
    cookie = await getSessionCookie(true);
    res = await doRequest(cookie);
  }

  if (!res.ok) {
    // Print the FULL absolute URL (not just the relative path) so a
    // 404/401 shows exactly what was requested.
    throw new Error(
      `Space-Track query failed: HTTP ${res.status} ${res.statusText} — ${url}`
    );
  }

  return (await res.json()) as T;
}

/* ------------------------------------------------------------
   Public data fetchers.
   ------------------------------------------------------------ */

/**
 * Fetch a sample of the latest TLEs for the 3D orbital map.
 * Newest epoch first; capped by `limit`.
 */
export async function fetchTLEs(limit: number): Promise<SpaceTrackTLE[]> {
  const safeLimit = Math.max(1, Math.min(limit, 10000));
  // `gp` (General Perturbations) is Space-Track's current recommended
  // class — returns one latest element set per object, no ORDINAL needed.
  const path = `class/gp/orderby/EPOCH%20desc/limit/${safeLimit}/format/json`;
  // Shared per-limit cache: /api/debris, /api/fleet and /api/screen all
  // ask for 2,000 rows and now share ONE download per instance per 10 min.
  return sharedFetch<SpaceTrackTLE[]>(`gp:${safeLimit}`, TLE_CACHE_TTL_MS, () =>
    spaceTrackGet<SpaceTrackTLE[]>(path)
  );
}

/**
 * Health probe: ONE real gp query that deliberately BYPASSES the shared
 * dataset cache, so /api/health measures live Space-Track round-trip
 * time and sees an outage as soon as its own cache expires.
 */
export async function probeGp(): Promise<SpaceTrackTLE[]> {
  return spaceTrackGet<SpaceTrackTLE[]>(
    "class/gp/orderby/EPOCH%20desc/limit/1/format/json"
  );
}

/**
 * Look up a single object for the risk scorer.
 * Numeric query -> NORAD_CAT_ID; otherwise wildcard name match (~~).
 * Returns null if nothing matches.
 */
export async function searchTLE(query: string): Promise<SpaceTrackTLE | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;

  const isNoradId = /^\d+$/.test(trimmed);
  const predicate = isNoradId
    ? `NORAD_CAT_ID/${encodeURIComponent(trimmed)}`
    : `OBJECT_NAME/~~${encodeURIComponent(trimmed)}`;

  const path = `class/gp/${predicate}/orderby/EPOCH%20desc/limit/1/format/json`;
  const results = await spaceTrackGet<SpaceTrackTLE[]>(path);
  return results.length > 0 ? results[0] : null;
}

/**
 * Fetch upcoming conjunction events (CDMs) for the alert feed.
 * Future TCA only, soonest first; capped by `limit`.
 */
export async function fetchConjunctions(
  limit: number
): Promise<SpaceTrackCDM[]> {
  const safeLimit = Math.max(1, Math.min(limit, CDM_SHARED_LIMIT));
  // ONE shared pull of the soonest CDM_SHARED_LIMIT rows (TCA asc),
  // sliced per caller: the alert feed (10), fleet (25) and the ISS
  // console (100) no longer trigger three separate downloads.
  const path = `class/cdm_public/TCA/%3Enow/orderby/TCA%20asc/limit/${CDM_SHARED_LIMIT}/format/json`;
  const rows = await sharedFetch<SpaceTrackCDM[]>(
    `cdm:${CDM_SHARED_LIMIT}`,
    CDM_CACHE_TTL_MS,
    () => spaceTrackGet<SpaceTrackCDM[]>(path)
  );
  return rows.slice(0, safeLimit);
}
