/* lib/rateLimit.ts — the pure token bucket behind middleware.ts
   (120-request burst, 2 tokens/s = 120 req/min sustained, per client IP,
   LRU-bounded memory). Time is injected, so every case is deterministic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_EXPENSIVE_RATE_LIMIT,
  API_RATE_LIMIT,
  MAX_CLIENT_KEY_LENGTH,
  clientKeyFromIp,
  createRateLimiter,
  rateLimitTier,
  requestsPerMinute,
} from "@/lib/rateLimit";

const T0 = 1_700_000_000_000;

test("published policy is 120 burst, 2/s refill, 10,000 keys", () => {
  assert.equal(API_RATE_LIMIT.capacity, 120);
  assert.equal(API_RATE_LIMIT.refillPerSecond, 2);
  assert.equal(API_RATE_LIMIT.maxKeys, 10_000);
  assert.equal(API_RATE_LIMIT.refillPerSecond * 60, 120, "120 req/min sustained");
});

test("120 allowed back to back, the 121st denied", () => {
  const rl = createRateLimiter({ capacity: 120, refillPerSecond: 2, maxKeys: 10_000 });
  for (let i = 0; i < 120; i++) {
    const d = rl.check("1.2.3.4", T0);
    assert.equal(d.allowed, true, `request ${i + 1} allowed`);
    assert.equal(d.remaining, 119 - i, `remaining after request ${i + 1}`);
    assert.equal(d.limit, 120);
    assert.equal(d.retryAfterSeconds, 0);
  }
  const denied = rl.check("1.2.3.4", T0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.equal(denied.limit, 120);
  assert.equal(denied.retryAfterSeconds, 1, "one token needs 0.5 s at 2/s → ceil = 1 s");
});

test("defaults equal the published policy", () => {
  const rl = createRateLimiter();
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (rl.check("k", T0).allowed) allowed++;
  assert.equal(allowed, 120);
});

test("refill after time passes", () => {
  const rl = createRateLimiter({ capacity: 120, refillPerSecond: 2 });
  for (let i = 0; i < 120; i++) rl.check("ip", T0);
  assert.equal(rl.check("ip", T0).allowed, false);
  // 0.4 s → 0.8 tokens: still denied, retry in ceil(0.2/2)=1 s
  const early = rl.check("ip", T0 + 400);
  assert.equal(early.allowed, false);
  assert.equal(early.retryAfterSeconds, 1);
  // 0.5 s after the start → exactly 1 token
  assert.equal(rl.check("ip", T0 + 500).allowed, true);
  assert.equal(rl.check("ip", T0 + 500).allowed, false);
  // 10 s later → 20 tokens
  let n = 0;
  while (rl.check("ip", T0 + 10_500).allowed) n++;
  assert.equal(n, 20);
  // a full minute idle refills to capacity, never beyond
  let m = 0;
  while (rl.check("ip", T0 + 10_500 + 3_600_000).allowed) m++;
  assert.equal(m, 120, "capped at capacity");
});

test("retryAfterSeconds scales with the deficit for slow refill", () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 0.1 });
  assert.equal(rl.check("a", T0).allowed, true);
  const d = rl.check("a", T0);
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterSeconds, 10);
  const d2 = rl.check("a", T0 + 2_500);
  assert.equal(d2.retryAfterSeconds, 8, "0.25 tokens accrued → 7.5 s → ceil 8");
});

test("sustained rate: 2 req/s forever is never denied, 3 req/s is", () => {
  const rl = createRateLimiter();
  for (let s = 0; s < 600; s++) {
    for (let k = 0; k < 2; k++) {
      assert.equal(rl.check("steady", T0 + s * 1000).allowed, true, `t=${s}s`);
    }
  }
  const fast = createRateLimiter();
  let firstDenial = -1;
  for (let s = 0; s < 600 && firstDenial < 0; s++) {
    for (let k = 0; k < 3; k++) {
      if (!fast.check("fast", T0 + s * 1000).allowed) {
        firstDenial = s;
        break;
      }
    }
  }
  // net drain 1 token/s from 120 → denial around t ≈ 120 s
  assert.ok(firstDenial >= 115 && firstDenial <= 125, `first denial at ${firstDenial}s`);
});

test("independent keys", () => {
  const rl = createRateLimiter({ capacity: 3, refillPerSecond: 1 });
  for (let i = 0; i < 3; i++) assert.equal(rl.check("a", T0).allowed, true);
  assert.equal(rl.check("a", T0).allowed, false);
  for (let i = 0; i < 3; i++) assert.equal(rl.check("b", T0).allowed, true, "b unaffected by a");
  assert.equal(rl.check("b", T0).allowed, false);
  assert.equal(rl.check("anonymous", T0).allowed, true);
  assert.equal(rl.size(), 3);
});

test("eviction keeps memory bounded at maxKeys", () => {
  const rl = createRateLimiter({ capacity: 5, refillPerSecond: 1, maxKeys: 100 });
  for (let i = 0; i < 10_000; i++) {
    rl.check(`10.0.${i >> 8}.${i & 255}`, T0 + i);
    assert.ok(rl.size() <= 100, `size ${rl.size()} after ${i + 1} keys`);
  }
  assert.equal(rl.size(), 100);
});

test("eviction removes the least-recently-seen key, not a hot one", () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 0.001, maxKeys: 3 });
  // Drain "hot" fully.
  rl.check("hot", T0);
  rl.check("hot", T0);
  assert.equal(rl.check("hot", T0).allowed, false);
  rl.check("x", T0 + 1);
  rl.check("y", T0 + 2);
  // Touch "hot" again so "x" is now the oldest.
  assert.equal(rl.check("hot", T0 + 3).allowed, false);
  rl.check("z", T0 + 4); // size 4 > 3 → evict oldest = "x"
  assert.equal(rl.size(), 3);
  // "hot" must still be drained (was NOT evicted)…
  assert.equal(rl.check("hot", T0 + 5).allowed, false, "hot key kept its empty bucket");
  // …and "x" restarts full (it was evicted).
  assert.equal(rl.check("x", T0 + 6).remaining, 1, "evicted key restarts full");
});

test("clock moving backwards never mints tokens", () => {
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 1 });
  rl.check("k", T0 + 10_000);
  rl.check("k", T0 + 10_000);
  assert.equal(rl.check("k", T0).allowed, false, "earlier timestamp → no refill");
  assert.equal(rl.check("k", T0 + 10_500).allowed, false, "only 0.5 s since the latest seen time");
  assert.equal(rl.check("k", T0 + 11_000).allowed, true);
});

test("non-finite now falls back to Date.now()", () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 1 });
  const d = rl.check("k", Number.NaN);
  assert.equal(d.allowed, true);
  assert.equal(Number.isFinite(d.remaining), true);
  const d2 = rl.check("k", Number.POSITIVE_INFINITY);
  assert.equal(Number.isFinite(d2.retryAfterSeconds), true);
});

test("reset() clears every bucket", () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 1 });
  rl.check("k", T0);
  assert.equal(rl.check("k", T0).allowed, false);
  rl.reset();
  assert.equal(rl.size(), 0);
  assert.equal(rl.check("k", T0).allowed, true);
});

test("invalid configuration throws RangeError", () => {
  assert.throws(() => createRateLimiter({ capacity: 0 }), RangeError);
  assert.throws(() => createRateLimiter({ capacity: Number.NaN }), RangeError);
  assert.throws(() => createRateLimiter({ refillPerSecond: 0 }), RangeError);
  assert.throws(() => createRateLimiter({ refillPerSecond: -1 }), RangeError);
  assert.throws(() => createRateLimiter({ refillPerSecond: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => createRateLimiter({ maxKeys: 0 }), RangeError);
  assert.throws(() => createRateLimiter({ maxKeys: 1.5 }), RangeError);
  assert.doesNotThrow(() => createRateLimiter(API_RATE_LIMIT));
});

test("module is Edge-safe: no Node-only identifiers in the source", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../lib/rateLimit.ts", import.meta.url), "utf8");
  for (const banned of ["require(", "from \"node:", "process.", "Buffer", "setTimeout", "setInterval", "import "]) {
    assert.ok(!src.includes(banned), `rateLimit.ts must not contain ${banned}`);
  }
});

test("expensive tier policy is 20 burst, 10/min sustained", () => {
  assert.equal(API_EXPENSIVE_RATE_LIMIT.capacity, 20);
  assert.equal(requestsPerMinute(API_EXPENSIVE_RATE_LIMIT), 10);
  assert.ok(API_EXPENSIVE_RATE_LIMIT.capacity < API_RATE_LIMIT.capacity);
});

test("rateLimitTier: every POST, /api/screen, /api/cola and uncached debris lookups are expensive", () => {
  const q = (o: Record<string, string> = {}) => new URLSearchParams(o);
  assert.equal(rateLimitTier("POST", "/api/analyze", q()), "expensive");
  assert.equal(rateLimitTier("post", "/api/cascade", q()), "expensive", "method case-insensitive");
  assert.equal(rateLimitTier("PUT", "/api/anything", q()), "expensive", "non-GET methods are never general");
  assert.equal(rateLimitTier("OPTIONS", "/api/analyze", q()), "general", "preflight reaches no route");
  assert.equal(rateLimitTier("GET", "/api/screen", q({ target: "ISS", hours: "24" })), "expensive");
  assert.equal(rateLimitTier("GET", "/API/Cola/", q()), "expensive", "path case + trailing slash normalised");
  assert.equal(rateLimitTier("GET", "/api/%73creen", q()), "expensive", "percent-encoded path decoded");
  assert.equal(rateLimitTier("HEAD", "/api/cola", q()), "expensive");
  // /api/debris: the two cached sample sizes are general, anything else hits Space-Track.
  assert.equal(rateLimitTier("GET", "/api/debris", q()), "general", "default limit 500 is cached");
  assert.equal(rateLimitTier("GET", "/api/debris", q({ limit: "2000" })), "general");
  assert.equal(rateLimitTier("GET", "/api/debris", q({ limit: "300" })), "expensive");
  assert.equal(rateLimitTier("GET", "/api/debris", q({ limit: "abc" })), "general", "unparseable → route default");
  assert.equal(rateLimitTier("GET", "/api/debris", q({ search: "   " })), "general", "blank search is a list");
  assert.equal(rateLimitTier("GET", "/api/debris", q({ search: "ISS" })), "expensive");
  // Cached, Claude-backed GETs stay general (single-key route caches bound their cost).
  assert.equal(rateLimitTier("GET", "/api/conjunctions", q()), "general");
  assert.equal(rateLimitTier("GET", "/api/fleet", q()), "general");
  assert.equal(rateLimitTier("GET", "/api/health", q()), "general");
});

test("clientKeyFromIp: IPv4 as is, IPv6 cut to /64, mapped IPv4 unwrapped, junk bounded", () => {
  assert.equal(clientKeyFromIp("1.2.3.4"), "1.2.3.4");
  assert.equal(clientKeyFromIp("1.2.3.4:5678"), "1.2.3.4", "trailing port dropped");
  assert.equal(clientKeyFromIp("2001:DB8:0:1:2:3:4:5"), "2001:db8:0:1::/64");
  assert.equal(clientKeyFromIp("2001:db8::1"), "2001:db8:0:0::/64", "compressed spelling");
  assert.equal(clientKeyFromIp("[2001:db8:0:1::7]:443"), "2001:db8:0:1::/64", "bracketed with port");
  assert.equal(clientKeyFromIp("fe80::1%eth0"), "fe80:0:0:0::/64", "zone id ignored");
  assert.equal(clientKeyFromIp("::ffff:192.0.2.1"), "192.0.2.1", "IPv4-mapped IPv6");
  assert.equal(
    clientKeyFromIp("2001:db8:0:1:aaaa:bbbb:cccc:dddd"),
    clientKeyFromIp("2001:db8:0:1:1111:2222:3333:4444"),
    "two hosts in one /64 share a bucket"
  );
  const junk = clientKeyFromIp("x".repeat(200));
  assert.ok(junk.length <= MAX_CLIENT_KEY_LENGTH, `junk key bounded (${junk.length})`);
});
