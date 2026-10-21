import { NextResponse, type NextRequest } from "next/server";
import {
  API_EXPENSIVE_RATE_LIMIT,
  API_RATE_LIMIT,
  clientKeyFromIp,
  createRateLimiter,
  rateLimitTier,
} from "@/lib/rateLimit";

/* ============================================================
   middleware.ts — public API hygiene for /api/* (Session 6, F5)

   Runs on the Next 14 Edge runtime BEFORE every /api/* route.
   It does exactly four things and is dependency-free:

   1. RATE LIMIT — token buckets per client IP (lib/rateLimit.ts),
      two tiers chosen by rateLimitTier():
        general   every request         burst 120, 120 requests/min
        expensive Claude POSTs, uncached Space-Track lookups and
                  heavy screens (/api/screen, /api/cola, /api/debris
                  search or a non-standard limit)
                                        burst 10, 10 requests/min —
                                        AND the general bucket
        allowed → NextResponse.next() + X-RateLimit-Limit /
                  X-RateLimit-Remaining (of the expensive bucket for
                  expensive requests) + X-RateLimit-Tier
        denied  → 429 { error: "Rate limit exceeded",
                  retryAfterSeconds } + Retry-After, with the
                  X-RateLimit-* of the bucket that denied it
      The dashboard itself makes ~20 requests/min per viewer, and
      every expensive call it makes is a human click or one call per
      page load, so a real viewer never hits either limit. Client
      key = first entry of x-forwarded-for, else x-real-ip, else
      "anonymous" (on Vercel the platform sets these headers itself);
      IPv6 clients are keyed by their /64.
      HONEST SCOPE: the bucket maps are per Edge isolate, so the
      limit is best-effort per instance, not a global guarantee.

   2. CORS — GET / HEAD responses, and preflights that ask for GET
      or HEAD, carry Access-Control-Allow-Origin: * (read-only data
      is public). Preflights for any other method (POST) get NO CORS
      headers, so the browser refuses the cross-origin request.
      OPTIONS is answered here with 204 — it never reaches a route.

   3. CROSS-ORIGIN WRITES — a POST (or any other non-GET/HEAD/OPTIONS
      method) that carries an Origin header for another host gets
      403 before any token is spent. This also stops "simple"
      text/plain POSTs that skip the preflight. Browsers send Origin
      on same-origin POSTs, so the dashboard is unaffected; curl and
      other server-side callers send no Origin and are unaffected.

   4. NEVER BREAK THE API — everything is wrapped in try/catch; any
      unexpected error falls through to NextResponse.next() so the
      route still answers.

   Every request that passes step 3, including a preflight, spends
   one general token.

   Local dev: under `next dev` (NODE_ENV=development) the buckets and
   the X-RateLimit-* headers still run, but requests are never
   DENIED — reactStrictMode double-fires every panel's effects, so a
   few quick refreshes would otherwise 429 the developer's own
   dashboard. `next start` and Vercel (production) enforce the limit.
   The cross-origin 403 applies everywhere.
   ============================================================ */

export const config = { matcher: "/api/:path*" };

/** Module scope = one limiter per tier per Edge isolate (see header). */
const generalLimiter = createRateLimiter(API_RATE_LIMIT);
const expensiveLimiter = createRateLimiter(API_EXPENSIVE_RATE_LIMIT);

/** On GET / HEAD responses and on GET / HEAD preflights. */
const CORS_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Tier, Retry-After",
};

/** Preflight-only additions (GET / HEAD preflights). */
const CORS_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function firstEntry(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

/** Client key: first x-forwarded-for entry, else x-real-ip, else "anonymous". */
function clientKey(req: NextRequest): string {
  const forwarded = clientKeyFromIp(firstEntry(req.headers.get("x-forwarded-for")));
  if (forwarded) return forwarded;
  const realIp = clientKeyFromIp(req.headers.get("x-real-ip") ?? "");
  if (realIp) return realIp;
  return "anonymous";
}

/** Deny only outside `next dev` (Next inlines NODE_ENV in the Edge bundle). */
function enforcing(): boolean {
  return process.env.NODE_ENV !== "development";
}

function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

/** CORS headers for this request: none for POST, nor for a preflight that asks for POST. */
function corsHeaders(req: NextRequest, method: string): Record<string, string> {
  if (method === "GET" || method === "HEAD") return { ...CORS_RESPONSE_HEADERS };
  if (method === "OPTIONS") {
    const requested = (req.headers.get("access-control-request-method") ?? "").trim().toUpperCase();
    if (requested === "GET" || requested === "HEAD") {
      return { ...CORS_RESPONSE_HEADERS, ...CORS_PREFLIGHT_HEADERS };
    }
  }
  return {};
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:(?:443|80)$/, "");
}

/**
 * True when a browser sent this request from another origin: an Origin
 * header is present and its host matches none of the request's own
 * host names. "Origin: null" (sandboxed frames, file://) counts as
 * cross-origin. No Origin (curl, server-side callers) is not.
 */
function isCrossOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = normalizeHost(new URL(origin).host);
  } catch {
    return true;
  }
  if (!originHost) return true;
  const ownHosts = [req.headers.get("host") ?? "", firstEntry(req.headers.get("x-forwarded-host")), req.nextUrl.host];
  return !ownHosts.some((host) => host !== "" && normalizeHost(host) === originHost);
}

function applyHeaders(res: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [name, value] of Object.entries(headers)) {
    res.headers.set(name, value);
  }
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  try {
    const method = req.method.toUpperCase();

    if (!isSafeMethod(method) && isCrossOrigin(req)) {
      return NextResponse.json(
        { error: "Cross-origin requests may only use GET." },
        { status: 403 }
      );
    }

    const key = clientKey(req);
    const tier = rateLimitTier(method, req.nextUrl.pathname, req.nextUrl.searchParams);
    const general = generalLimiter.check(key);
    // Expensive requests must pass BOTH buckets; the expensive bucket is
    // only spent once the general one has allowed the request.
    const decision =
      tier === "expensive" && general.allowed ? expensiveLimiter.check(key) : general;

    const headers: Record<string, string> = {
      "X-RateLimit-Limit": String(decision.limit),
      "X-RateLimit-Remaining": String(decision.remaining),
      "X-RateLimit-Tier": tier,
      ...corsHeaders(req, method),
    };

    if (!decision.allowed && enforcing()) {
      headers["Retry-After"] = String(decision.retryAfterSeconds);
      return applyHeaders(
        NextResponse.json(
          { error: "Rate limit exceeded", retryAfterSeconds: decision.retryAfterSeconds },
          { status: 429 }
        ),
        headers
      );
    }

    if (method === "OPTIONS") {
      return applyHeaders(new NextResponse(null, { status: 204 }), headers);
    }

    return applyHeaders(NextResponse.next(), headers);
  } catch (err) {
    // Never let the limiter take the API down.
    console.error(
      "[middleware] error:",
      err instanceof Error ? err.message : "Unknown error"
    );
    return NextResponse.next();
  }
}
