import { NextResponse } from "next/server";
import {
  SWPC_KP_URL,
  SWPC_F107_URL,
  parseKpResponse,
  parseF107Response,
  buildSpaceWeatherStatus,
  type SpaceWeatherReading,
  type SpaceWeatherStatus,
} from "@/lib/spaceweather";

/* ============================================================
   GET /api/spaceweather

   Session 5 — Feature 6 (Space Weather + Reentry Watch).

   Flow:
   1. Promise.allSettled over exactly TWO public NOAA SWPC feeds
      (planetary Kp + F10.7 solar radio flux) — the URL constants
      live in lib/spaceweather.ts and nothing else is fetched.
      Each request: cache "no-store", 8 s AbortSignal timeout, an
      identifying User-Agent (NOAA asks automated clients to do
      this), and an Accept: application/json header.
   2. Hand the raw JSON to the pure parsers (unit-tested) and
      assemble a SpaceWeatherStatus: Kp, F10.7, NOAA G-scale,
      heuristic LEO drag regime, per-feed error strings.
   3. Response codes:
        200  — at least one feed parsed (partial results carry the
               other feed's message in `errors`, never a 5xx)
        503  — BOTH feeds failed → { error, detail }
   4. Cache: single-key in-memory Map.
        15 min when both feeds succeeded (SWPC Kp updates every
        3 h / F10.7 daily, so 15 min is already generous), and
        2 min when one feed failed so a transient upstream hiccup
        does not pin an "unavailable" note on the dashboard for a
        quarter of an hour. Failures (503) are never cached.

   No Claude call, no Space-Track call — this route costs nothing
   per request and needs no credentials.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CACHE_TTL_FULL_MS = 15 * 60 * 1000; // 15 minutes — both feeds OK
const CACHE_TTL_PARTIAL_MS = 2 * 60 * 1000; // 2 minutes — one feed failed
const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "SpaceDebris/1.0 (space-debris-two.vercel.app)";
const CACHE_KEY = "spaceweather";

interface CacheEntry {
  data: SpaceWeatherStatus;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(): SpaceWeatherStatus | null {
  const entry = cache.get(CACHE_KEY);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(CACHE_KEY);
  return null;
}

function setCached(data: SpaceWeatherStatus, ttlMs: number): void {
  cache.set(CACHE_KEY, { data, expires: Date.now() + ttlMs });
}

/** Fetch one SWPC product and return its parsed JSON body (unknown). */
async function fetchSwpcJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  }
  return res.json();
}

/** Human-readable reason from a rejected promise (DOMException, Error, other). */
function describeFailure(reason: unknown): string {
  if (reason instanceof Error) {
    // AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
    if (reason.name === "TimeoutError" || reason.name === "AbortError") {
      return `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    }
    return reason.message || reason.name || "Unknown error";
  }
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "Unknown error";
}

/**
 * Resolve one feed: settled fetch result → parsed reading or an
 * error message. Keeps GET() linear and makes the two feeds
 * symmetric.
 */
function resolveFeed(
  settled: PromiseSettledResult<unknown>,
  parse: (json: unknown) => SpaceWeatherReading | null,
  emptyMessage: string
): { reading: SpaceWeatherReading | null; error?: string } {
  if (settled.status === "rejected") {
    return { reading: null, error: describeFailure(settled.reason) };
  }
  let reading: SpaceWeatherReading | null = null;
  try {
    reading = parse(settled.value);
  } catch (err) {
    return { reading: null, error: describeFailure(err) };
  }
  if (!reading) return { reading: null, error: emptyMessage };
  return { reading };
}

export async function GET(): Promise<NextResponse> {
  const cached = getCached();
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const [kpSettled, f107Settled] = await Promise.allSettled([
      fetchSwpcJson(SWPC_KP_URL),
      fetchSwpcJson(SWPC_F107_URL),
    ]);

    const kp = resolveFeed(
      kpSettled,
      parseKpResponse,
      "SWPC Kp feed returned no finite Kp value."
    );
    const f107 = resolveFeed(
      f107Settled,
      parseF107Response,
      "SWPC F10.7 feed returned no finite flux value."
    );

    const errors: { kp?: string; f107?: string } = {};
    if (kp.error) errors.kp = kp.error;
    if (f107.error) errors.f107 = f107.error;

    if (!kp.reading && !f107.reading) {
      const detail = `kp: ${kp.error ?? "unavailable"}; f107: ${
        f107.error ?? "unavailable"
      }`;
      console.error("[/api/spaceweather] error:", detail);
      return NextResponse.json(
        { error: "NOAA SWPC space-weather feeds are unavailable.", detail },
        { status: 503 }
      );
    }

    const status = buildSpaceWeatherStatus({
      fetchedAt: new Date().toISOString(),
      kp: kp.reading,
      f107: f107.reading,
      errors,
    });

    const bothOk = kp.reading !== null && f107.reading !== null;
    setCached(status, bothOk ? CACHE_TTL_FULL_MS : CACHE_TTL_PARTIAL_MS);
    if (!bothOk) {
      console.error(
        "[/api/spaceweather] partial:",
        JSON.stringify(errors)
      );
    }

    return NextResponse.json(status);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/spaceweather] error:", detail);
    return NextResponse.json(
      { error: "Failed to load space-weather status.", detail },
      { status: 500 }
    );
  }
}
