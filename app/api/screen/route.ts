import { NextResponse, type NextRequest } from "next/server";
import { fetchTLEs, searchTLE } from "@/lib/spacetrack";
import {
  DEFAULT_SCREENING_OPTIONS,
  SCREENING_WINDOW_OPTIONS,
  screenTarget,
} from "@/lib/screening";
import type { ScreeningResult } from "@/lib/prompts";

/* ============================================================
   GET /api/screen?target=<name|NORAD>&hours=<6|12|24|48>

   Deterministic SGP4 conjunction screening of ONE target against
   the 2,000-object Space-Track gp sample. No Claude call here —
   the AI assessment memo is a separate POST /api/assess so the
   physics stays reproducible and cheap to re-run.

   Flow
   1. Validate `target` (trimmed, 1-64 chars) and `hours`
      (one of 6 / 12 / 24 / 48, default 24).
   2. 5-minute in-memory cache keyed on target.toLowerCase()|hours.
   3. Promise.all([searchTLE(query), fetchTLEs(2000)]) — one
      Space-Track round trip for each, in parallel. `query` is the
      target as typed, except that the bare word "ISS" (the UI's
      default) is mapped to NORAD 25544 first: searchTLE's name
      lookup is a wildcard OBJECT_NAME/~~ISS ordered by newest
      epoch, so without the alias the demo's first click could
      silently screen "ISS DEB …" or SWISSCUBE instead of ISS
      (ZARYA). Any other name goes through the wildcard unchanged.
   4. 404 if the target is not in the catalog.
   5. screenTarget(target, sample, now, { windowHours }) from
      lib/screening.ts (see its header for the full algorithm):
        - PREFILTER: keep only sample objects whose perigee-apogee
          band (±75 km) overlaps the target's; sort by altitude
          proximity; cap at 1,500 candidates.
        - COARSE search: 60 s grid over the window, separation per
          step, interior local minima below a gate (threshold +
          vMaxRel × step / 2) are candidates. A rigorous
          escape-speed bound lets the walk skip grid points that
          provably cannot host a sub-threshold approach.
        - FINE search: golden-section refinement of each minimum to
          0.05 s, both objects re-propagated per evaluation; only
          the closest approach per candidate is kept.
        - Pc ASSUMPTION: each object carries an assumed 1-σ RIC
          covariance of 0.3 / 1.0 / 0.3 km (TLE-grade), combined
          hard-body radius 20 m, short-encounter 2-D integral. This
          is an ESTIMATE under a stated covariance — it is not an
          operator Pc and not an 18 SDS CDM. The assumptions are
          returned in the payload so the UI shows them verbatim.
   6. Return the ScreeningResult (sorted by miss distance).

   Why cache per target for 5 minutes
   - The screen is a pure function of (target TLE, sample, start
     time). TLEs refresh a few times a day and the result is valid
     for far longer than 5 minutes, so repeated clicks on the same
     target (the demo pattern) should not re-spend ~1-20 s of CPU
     and two Space-Track calls each time. Per-target keys mean a
     different target or window is never served a stale answer.
   - Space-Track's rate limit is 30 req/min; caching protects it.

   Compute budget: lib/screening defaults to a 20 s wall-clock
   budget, but that clock only starts AFTER the Space-Track I/O
   (login + searchTLE + fetchTLEs can take several seconds on a
   cold path). So the handler measures the time already spent and
   hands screenTarget the smaller of the 20 s default and
   (maxDuration − 5 s headroom − elapsed), floored at 2 s. The walk
   then always ends with a proper truncated = true result instead
   of the platform killing the function at maxDuration = 30
   (vercel.json carries the same value) and the client seeing a
   generic 5xx. If the budget trips, the UI tells the operator to
   rerun with a shorter window.
   ============================================================ */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SCREEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEBRIS_SAMPLE = 2000; // matches OrbitalMap DEBRIS_LIMIT / debrisClient
const MAX_TARGET_LENGTH = 64;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_CACHE_ENTRIES = 64;
/** Wall-clock the whole request may use before the compute walk must stop. */
const REQUEST_DEADLINE_MS = (maxDuration - 5) * 1000; // 5 s headroom for JSON + platform
/** Never hand screenTarget less than this, so a slow I/O path still screens something. */
const MIN_COMPUTE_BUDGET_MS = 2000;

/**
 * Catalog aliases resolved before searchTLE. Lower-cased input → NORAD ID.
 * Only the bare "ISS" is aliased (see header, step 3); names such as
 * "ISS (ZARYA)" are specific enough for the wildcard lookup already.
 * A Map (not an object literal) so user input such as "constructor" or
 * "__proto__" can never resolve through Object.prototype.
 */
interface CacheEntry {
  data: ScreeningResult;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): ScreeningResult | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCached(key: string, data: ScreeningResult): void {
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
  cache.set(key, { data, expires: Date.now() + SCREEN_CACHE_TTL_MS });
}

/** Parse + validate `hours`; returns null when invalid. */
function parseHours(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return DEFAULT_WINDOW_HOURS;
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || !SCREENING_WINDOW_OPTIONS.includes(parsed)) {
    return null;
  }
  return parsed;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestStart = Date.now();
  const params = req.nextUrl.searchParams;

  const target = (params.get("target") ?? "").trim();
  if (!target) {
    return NextResponse.json(
      { error: "Missing required query parameter: target (satellite name or NORAD ID)." },
      { status: 400 }
    );
  }
  if (target.length > MAX_TARGET_LENGTH) {
    return NextResponse.json(
      { error: `target must be at most ${MAX_TARGET_LENGTH} characters.` },
      { status: 400 }
    );
  }

  const hours = parseHours(params.get("hours"));
  if (hours === null) {
    return NextResponse.json(
      { error: `hours must be one of ${SCREENING_WINDOW_OPTIONS.join(", ")}.` },
      { status: 400 }
    );
  }

  const cacheKey = `${target.toLowerCase()}|${hours}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    const [targetTle, sample] = await Promise.all([
      searchTLE(target), // bare "ISS" → NORAD 25544 inside searchTLE (shared with /api/debris?search and /api/analyze)
      fetchTLEs(DEBRIS_SAMPLE),
    ]);

    if (!targetTle) {
      return NextResponse.json(
        { error: `No object found matching "${target}"` },
        { status: 404 }
      );
    }

    // Compute budget = what is left of the request deadline after the
    // Space-Track I/O, never more than the library default (see header).
    const elapsedMs = Date.now() - requestStart;
    const timeBudgetMs = Math.min(
      DEFAULT_SCREENING_OPTIONS.timeBudgetMs,
      Math.max(MIN_COMPUTE_BUDGET_MS, REQUEST_DEADLINE_MS - elapsedMs)
    );

    const result = screenTarget(targetTle, sample, new Date(), {
      windowHours: hours,
      timeBudgetMs,
    });

    setCached(cacheKey, result);
    return NextResponse.json(result);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    console.error("[/api/screen] error:", detail);
    return NextResponse.json(
      { error: "Failed to run conjunction screen.", detail },
      { status: 500 }
    );
  }
}
