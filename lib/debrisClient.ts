import type { SpaceTrackTLE } from "@/lib/spacetrack";

/* ============================================================
   SpaceDebris — browser-side shared debris sample

   Several Session-5 panels (Orbital Density Profile, Fragmentation
   Family Tracker, Reentry Watch) all need the same 2,000-object
   Space-Track sample that the 3D OrbitalMap already pulls from
   GET /api/debris?limit=2000.

   Rather than each component firing its own request on mount,
   they share ONE in-flight promise + ONE cached result here, so a
   cold page load costs exactly one extra /api/debris round trip
   (served from the route's own 10-minute cache on the server).

   - Pure client module: no React, no server imports.
   - Never throws synchronously; failures reject the promise so
     each caller can render its own error state.
   - Does NOT touch OrbitalMap.tsx — the map keeps its own fetch.
   ============================================================ */

/** Must match OrbitalMap.tsx DEBRIS_LIMIT so cache keys line up. */
export const DEBRIS_SAMPLE_LIMIT = 2000;

/** Mirrors the /api/debris server cache (10 min). */
const SAMPLE_TTL_MS = 10 * 60 * 1000;

export interface DebrisSample {
  objects: SpaceTrackTLE[];
  fetchedAt: Date;
}

let cached: DebrisSample | null = null;
let inflight: Promise<DebrisSample> | null = null;

/**
 * Get the shared debris sample. Concurrent callers share one request;
 * subsequent callers get the cached sample until it expires.
 * Pass `force = true` to bypass the cache (manual refresh buttons).
 */
export function getDebrisSample(force = false): Promise<DebrisSample> {
  if (!force && cached && Date.now() - cached.fetchedAt.getTime() < SAMPLE_TTL_MS) {
    return Promise.resolve(cached);
  }
  if (!force && inflight) {
    return inflight;
  }

  const request = (async (): Promise<DebrisSample> => {
    const res = await fetch(`/api/debris?limit=${DEBRIS_SAMPLE_LIMIT}`);
    let data: { objects?: unknown; error?: unknown } = {};
    try {
      data = await res.json();
    } catch {
      // fall through — handled by !res.ok / shape checks below
    }
    if (!res.ok) {
      const msg =
        typeof data.error === "string"
          ? data.error
          : `Debris request failed (HTTP ${res.status}).`;
      throw new Error(msg);
    }
    const objects = Array.isArray(data.objects)
      ? (data.objects as SpaceTrackTLE[])
      : [];
    const sample: DebrisSample = { objects, fetchedAt: new Date() };
    cached = sample;
    return sample;
  })();

  inflight = request;
  request
    .catch(() => {
      /* error surfaces to callers; nothing to do here */
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });

  return request;
}

/** Synchronous peek at whatever is cached (may be null). */
export function peekDebrisSample(): DebrisSample | null {
  return cached;
}
