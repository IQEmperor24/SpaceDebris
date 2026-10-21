import { NextResponse, type NextRequest } from "next/server";
import { fetchTLEs } from "@/lib/spacetrack";
import {
  COLA_WINDOW_OPTIONS,
  DEFAULT_COLA_OPTIONS,
  LAUNCH_SITES,
  TARGET_ORBITS,
  findLaunchSite,
  findTargetOrbit,
  orbitReachable,
  screenLaunchWindow,
  type ColaResult,
} from "@/lib/launch";

/* ============================================================
   GET /api/cola?site=<id>&orbit=<id>&minutes=<60|120|240>[&start=<ISO>]

   Launch collision-avoidance (COLA) screening (Session 6, Feature 3).
   Deterministic — no Claude call. For every launch minute in the
   window the simplified ascent model in lib/launch.ts inserts the
   vehicle into the target orbit at T+9 min, coasts it two-body for
   20 min and screens it against the 2,000-object Space-Track gp
   sample at 30 s steps (with straight-line refinement inside each
   step). NO-GO < 5 km, CAUTION < 25 km, else GO.

   Parameters (all validated, all bounded)
   - site    one of LAUNCH_SITES ids   (default "slc-40")
   - orbit   one of TARGET_ORBITS ids  (default "starlink-550")
   - minutes one of 60 / 120 / 240     (default 120)
   - start   optional ISO-8601 date-time, ≤ 64 chars, within ±7 days of
             now; defaults to now. No offset = UTC. Rounded DOWN to the
             whole minute.
   400 { error } for any invalid parameter, and for a site / orbit
   pair whose inclination is below the site latitude (no direct-
   ascent plane exists) — checked BEFORE any Space-Track request.

   Flow
   1. Validate → cache lookup (key site|orbit|minutes|startMinuteMs,
      TTL 5 min, bounded at 64 entries). Repeat clicks inside the
      same minute are free; a new minute is a new window.
   2. fetchTLEs(2000) — shared per-instance 10-min dataset cache in
      lib/spacetrack, so this usually costs zero Space-Track calls.
   3. screenLaunchWindow(...) with a compute budget of
      min(20 s, (maxDuration − 5 s) − elapsed I/O), floored at 2 s,
      so the walk always ends with truncated = true instead of the
      platform killing the function at maxDuration.
   4. Return the ColaResult JSON.

   Errors: 500 { error, detail } + console.error("[/api/cola] error:").
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const COLA_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const DEBRIS_SAMPLE = 2000; // matches OrbitalMap DEBRIS_LIMIT / debrisClient
const DEFAULT_SITE_ID = "slc-40";
const DEFAULT_ORBIT_ID = "starlink-550";
const DEFAULT_WINDOW_MINUTES = 120;
const MAX_ID_LENGTH = 32;
const MAX_START_LENGTH = 64;
const MAX_START_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;
/** Wall-clock the whole request may use before the compute walk must stop. */
const REQUEST_DEADLINE_MS = (maxDuration - 5) * 1000;
const MIN_COMPUTE_BUDGET_MS = 2000;

interface CacheEntry {
  data: ColaResult;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): ColaResult | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCached(key: string, data: ColaResult): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    const expired: string[] = [];
    cache.forEach((v, k) => {
      if (v.expires <= now) expired.push(k);
    });
    for (const k of expired) cache.delete(k);
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }
  cache.set(key, { data, expires: Date.now() + COLA_CACHE_TTL_MS });
}

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/** Trimmed id or the default; null when present but too long. */
function readId(raw: string | null, fallback: string): string | null {
  if (raw === null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v.length > MAX_ID_LENGTH ? null : v;
}

function parseMinutes(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_WINDOW_MINUTES;
  const trimmed = raw.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) && COLA_WINDOW_OPTIONS.includes(n) ? n : null;
}

/** Start rounded down to the minute; null when invalid / out of range. */
function parseStart(raw: string | null, nowMs: number): number | null {
  if (raw === null || raw.trim() === "") return Math.floor(nowMs / 60_000) * 60_000;
  const trimmed = raw.trim();
  if (trimmed.length > MAX_START_LENGTH) return null;
  // Require a date-time shape so bare numbers / words never reach Date.parse.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return null;
  // ECMAScript parses an offset-less date-time as LOCAL time; this API is
  // UTC throughout, so a missing offset means UTC on every server.
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const ms = Date.parse(hasOffset ? trimmed : `${trimmed}Z`);
  if (!Number.isFinite(ms)) return null;
  if (Math.abs(ms - nowMs) > MAX_START_OFFSET_MS) return null;
  return Math.floor(ms / 60_000) * 60_000;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestStart = Date.now();
  const params = req.nextUrl.searchParams;

  const siteId = readId(params.get("site"), DEFAULT_SITE_ID);
  const site = siteId === null ? null : findLaunchSite(siteId);
  if (!site) {
    return badRequest(
      `site must be one of: ${LAUNCH_SITES.map((s) => s.id).join(", ")}.`
    );
  }

  const orbitId = readId(params.get("orbit"), DEFAULT_ORBIT_ID);
  const orbit = orbitId === null ? null : findTargetOrbit(orbitId);
  if (!orbit) {
    return badRequest(
      `orbit must be one of: ${TARGET_ORBITS.map((o) => o.id).join(", ")}.`
    );
  }

  const minutes = parseMinutes(params.get("minutes"));
  if (minutes === null) {
    return badRequest(`minutes must be one of ${COLA_WINDOW_OPTIONS.join(", ")}.`);
  }

  const startMs = parseStart(params.get("start"), requestStart);
  if (startMs === null) {
    return badRequest(
      "start must be an ISO-8601 date-time (e.g. 2026-10-21T14:00:00Z) within 7 days of now."
    );
  }

  if (!orbitReachable(site, orbit)) {
    return badRequest(
      `${orbit.label} (inclination ${orbit.inclinationDeg}°) cannot be reached by a direct ascent from ${site.label} (latitude ${site.latitudeDeg}°): the inclination is below the site latitude.`
    );
  }

  const cacheKey = `${site.id}|${orbit.id}|${minutes}|${startMs}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const fetched = await fetchTLEs(DEBRIS_SAMPLE);
    const sample = Array.isArray(fetched) ? fetched : [];

    const elapsedMs = Date.now() - requestStart;
    const timeBudgetMs = Math.min(
      DEFAULT_COLA_OPTIONS.timeBudgetMs,
      Math.max(MIN_COMPUTE_BUDGET_MS, REQUEST_DEADLINE_MS - elapsedMs)
    );

    const result = screenLaunchWindow(site, orbit, sample, new Date(startMs), minutes, {
      stepMinutes: DEFAULT_COLA_OPTIONS.stepMinutes,
      timeBudgetMs,
    });

    setCached(cacheKey, result);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/cola] error:", detail);
    return NextResponse.json(
      { error: "Failed to run launch COLA screen.", detail },
      { status: 500 }
    );
  }
}
