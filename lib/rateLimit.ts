/* ============================================================
   SpaceDebris — per-key token-bucket rate limiter (Session 6, F5)

   PURE + EDGE-SAFE: no Node APIs, no imports, no timers. Used by
   middleware.ts (Next 14 Edge runtime) to limit /api/* per client
   IP, and documented by lib/apiSpec.ts from the SAME constants
   and the SAME classifier below, so the published policy can never
   drift from the code.

   Two tiers (rateLimitTier decides which one a request is in)
   - general   — every /api/* request: burst 120, 120/min sustained.
   - expensive — requests that spend a scarce resource: Anthropic
     credits (every POST route is Claude-backed), an uncached
     Space-Track query (/api/debris search or a non-standard list
     size, /api/screen's target lookup) or up to ~20 s of server CPU
     (/api/screen, /api/cola). Burst 10, 10/min sustained, and the
     request must ALSO pass the general bucket. Every dashboard use
     of these routes is a human click or one call per page load, so
     10/min never affects a real viewer — but a script can no longer
     drain the Anthropic balance or push Space-Track past 30/min.

   Algorithm (classic token bucket, lazily refilled)
   - Each key owns a bucket of at most `capacity` tokens. A fresh
     key starts FULL.
   - On check(key, now): tokens += (now − lastRefill) × refillPerSecond,
     capped at capacity. If tokens ≥ 1 the request is allowed and
     one token is spent; otherwise it is denied and
     retryAfterSeconds = ceil((1 − tokens) / refillPerSecond).
   - capacity 120 + refill 2/s ⇒ bursts of up to 120 requests, and
     120 requests/minute sustained. (Strictly, a client that starts
     full can make 120 + 2·t requests in the first t seconds — a
     token bucket is a rate + burst policy, not a fixed window.)

   Memory bound
   - Buckets live in ONE Map whose insertion order doubles as an
     LRU list: every check() moves its key to the end, and while
     size > maxKeys the FIRST (least-recently-seen) key is deleted.
     Worst case is maxKeys entries × ~100 bytes ≈ 1 MB at 10,000.
   - Evicting a key only ever makes the limiter MORE permissive for
     that key (it restarts full); it can never wrongly deny.

   Client key (clientKeyFromIp)
   - IPv4 addresses are used as is (/32). IPv6 addresses are cut to
     their /64 prefix: a home ISP or cloud VM hands every client a
     whole /64, so a per-/128 key would give a client a fresh bucket
     for every source address it rotates through.

   Scope / honesty
   - State is per process (per Edge isolate / serverless instance).
     On Vercel several instances may run at once, so the limit is
     BEST-EFFORT per instance, not a global guarantee. A durable,
     global limiter would need a shared store (e.g. Redis/KV).
   ============================================================ */

/** Published API rate-limit policy — middleware.ts and lib/apiSpec.ts both read this. */
export const API_RATE_LIMIT = {
  /** Burst size: a fresh client may make this many requests back to back. */
  capacity: 120,
  /** Sustained refill: 2 tokens/s = 120 requests/minute. */
  refillPerSecond: 2,
  /** Distinct client keys remembered before least-recently-seen eviction. */
  maxKeys: 10_000,
} as const;

/**
 * Stricter policy for EXPENSIVE requests (see rateLimitTier). A request
 * in this tier spends a token from this bucket AND from API_RATE_LIMIT.
 */
export const API_EXPENSIVE_RATE_LIMIT = {
  /** Burst size: ten expensive calls back to back. */
  capacity: 10,
  /** Sustained refill: 10 tokens per minute. */
  refillPerSecond: 10 / 60,
  /** Distinct client keys remembered before least-recently-seen eviction. */
  maxKeys: 10_000,
} as const;

export type RateLimitTier = "general" | "expensive";

/** Policy per tier — what middleware.ts enforces and lib/apiSpec.ts documents. */
export const RATE_LIMIT_TIERS: Readonly<Record<RateLimitTier, Readonly<Required<RateLimiterOptions>>>> = {
  general: API_RATE_LIMIT,
  expensive: API_EXPENSIVE_RATE_LIMIT,
};

/** Sustained requests per minute implied by a policy's refill rate. */
export function requestsPerMinute(policy: Readonly<Required<RateLimiterOptions>>): number {
  return Math.round(policy.refillPerSecond * 60);
}

export interface RateLimiterOptions {
  /** Max tokens per key (burst). Finite, ≥ 1. */
  capacity?: number;
  /** Tokens added per second per key. Finite, > 0. */
  refillPerSecond?: number;
  /** Max distinct keys tracked before LRU eviction. Integer, ≥ 1. */
  maxKeys?: number;
}

export interface RateLimitDecision {
  /** True when the request may proceed (one token was spent). */
  allowed: boolean;
  /** Whole tokens left after this decision (0 when denied). */
  remaining: number;
  /** Seconds until one token is available again; 0 when allowed. */
  retryAfterSeconds: number;
  /** The bucket capacity — what X-RateLimit-Limit reports. */
  limit: number;
}

export interface RateLimiter {
  /** Spend one token for `key` at time `now` (epoch ms). Never throws. */
  check(key: string, now?: number): RateLimitDecision;
  /** Number of keys currently tracked (always ≤ maxKeys). */
  size(): number;
  /** Drop every bucket (tests / ops). */
  reset(): void;
}

interface Bucket {
  tokens: number;
  /** Epoch ms of the last refill computation. */
  updatedAt: number;
}

/**
 * Create an independent token-bucket limiter. Options default to
 * API_RATE_LIMIT. Throws RangeError for an invalid configuration so a
 * bad constant fails loudly in tests/CI instead of silently allowing
 * (or denying) everything in production.
 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const capacity = options.capacity ?? API_RATE_LIMIT.capacity;
  const refillPerSecond = options.refillPerSecond ?? API_RATE_LIMIT.refillPerSecond;
  const maxKeys = options.maxKeys ?? API_RATE_LIMIT.maxKeys;

  if (!Number.isFinite(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a finite number >= 1 (got ${capacity})`);
  }
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
    throw new RangeError(`refillPerSecond must be a finite number > 0 (got ${refillPerSecond})`);
  }
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new RangeError(`maxKeys must be an integer >= 1 (got ${maxKeys})`);
  }

  const limit = Math.floor(capacity);
  const refillPerMs = refillPerSecond / 1000;
  const buckets = new Map<string, Bucket>();

  function check(key: string, now: number = Date.now()): RateLimitDecision {
    const t = Number.isFinite(now) ? now : Date.now();
    const k = typeof key === "string" ? key : String(key);

    const existing = buckets.get(k);
    let bucket: Bucket;
    if (existing) {
      // Clock moving backwards (skew between isolates) never adds tokens.
      const elapsedMs = Math.max(0, t - existing.updatedAt);
      bucket = {
        tokens: Math.min(capacity, existing.tokens + elapsedMs * refillPerMs),
        updatedAt: Math.max(existing.updatedAt, t),
      };
      // Delete + re-set below moves the key to the most-recent end.
      buckets.delete(k);
    } else {
      bucket = { tokens: capacity, updatedAt: t };
    }

    let decision: RateLimitDecision;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      decision = {
        allowed: true,
        remaining: Math.max(0, Math.floor(bucket.tokens)),
        retryAfterSeconds: 0,
        limit,
      };
    } else {
      decision = {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond)),
        limit,
      };
    }

    buckets.set(k, bucket);

    // LRU-ish eviction: Map iteration order = least-recently-seen first.
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) break;
      buckets.delete(oldest.value);
    }

    return decision;
  }

  return {
    check,
    size: () => buckets.size,
    reset: () => buckets.clear(),
  };
}

/* ------------------------------------------------------------
   Request classification (which tier a request is in)
   ------------------------------------------------------------ */

/** Mirrors DEFAULT_LIMIT in app/api/debris/route.ts. */
const DEBRIS_DEFAULT_LIMIT = 500;

/**
 * /api/debris list sizes served from the shared, cached sample: the
 * route default (500) and the dashboard's map / panel sample (2000).
 * Any other size is a fresh Space-Track pull of up to 10,000 rows.
 */
export const DEBRIS_CACHED_LIMITS: readonly number[] = [DEBRIS_DEFAULT_LIMIT, 2000];

/**
 * GET routes where EVERY call is expensive: each distinct target or
 * window costs an uncached Space-Track lookup (/api/screen) and/or up
 * to ~20 s of server CPU (/api/screen, /api/cola).
 */
export const EXPENSIVE_GET_PATHS: readonly string[] = ["/api/screen", "/api/cola"];

/** The one method of URLSearchParams the classifier needs. */
export interface QueryLike {
  get(name: string): string | null;
}

/** Decoded, lower-cased, no trailing slash — stricter on odd spellings, never looser. */
function normalizePath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Malformed escape: classify the raw path.
  }
  path = path.toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Tier of one request. Pure; mirrors the routes' own parameter
 * parsing so a request is "general" exactly when the route can answer
 * it from a bounded cache without Claude.
 * - OPTIONS                      → general (preflight; reaches no route)
 * - POST and any other non-GET/HEAD method → expensive (every POST
 *   route calls Claude)
 * - GET/HEAD /api/screen, /api/cola → expensive
 * - GET/HEAD /api/debris with a non-blank `search`, or a `limit` that
 *   (parsed like the route does) is not in DEBRIS_CACHED_LIMITS → expensive
 * - everything else              → general
 */
export function rateLimitTier(method: string, pathname: string, query: QueryLike): RateLimitTier {
  const m = method.toUpperCase();
  if (m === "OPTIONS") return "general";
  if (m !== "GET" && m !== "HEAD") return "expensive";

  const path = normalizePath(pathname);
  if (EXPENSIVE_GET_PATHS.includes(path)) return "expensive";

  if (path === "/api/debris") {
    const search = query.get("search");
    if (search && search.trim()) return "expensive";
    const raw = query.get("limit");
    const parsed = raw ? parseInt(raw, 10) : DEBRIS_DEFAULT_LIMIT;
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : DEBRIS_DEFAULT_LIMIT;
    return DEBRIS_CACHED_LIMITS.includes(limit) ? "general" : "expensive";
  }

  return "general";
}

/* ------------------------------------------------------------
   Client key (IPv4 /32, IPv6 /64)
   ------------------------------------------------------------ */

/** Longest key kept, so a hostile header cannot bloat the bucket map. */
export const MAX_CLIENT_KEY_LENGTH = 64;

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function parseIpv6(text: string): number[] | null {
  let s = text;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) → two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : Number.NaN));
    if (octets.length !== 4 || octets.some((o) => !(o >= 0 && o <= 255))) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = head.concat(new Array<string>(halves.length === 2 ? missing : 0).fill("0"), rest);
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

/**
 * Rate-limit key for one client address (already split out of
 * x-forwarded-for / x-real-ip). Pure; never throws.
 * - IPv4 → unchanged (a trailing :port is dropped).
 * - IPv6 → its /64 prefix, e.g. "2001:db8:0:1::/64", whatever the
 *   spelling (compressed, upper case, zone id, [brackets]:port).
 * - IPv4-mapped IPv6 (::ffff:a.b.c.d) → the IPv4 address.
 * - Anything unparseable → the raw text, cut to MAX_CLIENT_KEY_LENGTH.
 */
export function clientKeyFromIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith("[")) {
    const end = ip.indexOf("]");
    if (end > 0) ip = ip.slice(1, end);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(ip)) {
    ip = ip.slice(0, ip.lastIndexOf(":"));
  }

  if (ip.includes(":")) {
    const g = parseIpv6(ip);
    if (g) {
      const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
      if (mapped) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
      return `${g.slice(0, 4).map((h) => h.toString(16)).join(":")}::/64`;
    }
  }
  return ip.slice(0, MAX_CLIENT_KEY_LENGTH);
}
