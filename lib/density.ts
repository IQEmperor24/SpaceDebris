import type { SpaceTrackTLE } from "@/lib/spacetrack";
import {
  classifyObjectName,
  meanAltitudeKm,
  type ObjectClass,
} from "@/lib/orbital";

/* ============================================================
   SpaceDebris — orbital density histograms (Session 5, Feature 5)

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic.
   Turns the browser-side Space-Track sample (lib/debrisClient.ts,
   2,000 most-recently-updated gp rows) into ORDEM-style
   altitude and inclination histograms for the Orbital Density
   Profile panel (components/DensityProfile.tsx).

   What this IS: a count of the objects in the live sample per
   altitude / inclination bin, split by coarse object class.
   What this is NOT: a spatial-density model. ORDEM / MASTER
   produce objects-per-km³ from the full catalog plus statistical
   populations; here we only bin ~2,000 catalogued element sets,
   so the UI must label the result a SAMPLE, never "the catalog".

   Conventions
   - Altitude = mean of the gp APOAPSIS / PERIAPSIS strings via
     meanAltitudeKm() (equatorial-radius convention, same as
     /api/fleet). NaN rows are skipped entirely (not counted).
   - Bins are half-open [from, to): an object exactly at a bin
     edge belongs to the HIGHER bin. The altitude range is
     [minKm, maxKm): exactly 2,000 km is "above" (consistent with
     classifyShell(), where LEO is alt < 2000).
   - Inclination bins span 0–180° and the single exception to the
     half-open rule is 180° itself, which lands in the last bin.
   - Object class comes from classifyObjectName(OBJECT_NAME):
     " DEB" → DEBRIS, "R/B" / "AKM" / "PKM" → ROCKET BODY,
     "TBA" / "UNKNOWN" → UNKNOWN, everything else → PAYLOAD.
     This is a NAME heuristic, not a catalog attribute — label
     it an estimate on screen.
   - The Kessler-critical shell is 700–1000 km (half-open). It is
     counted directly from object altitudes, not by summing bins,
     so the share stays exact for any bin size.
   ============================================================ */

/* ------------------------------------------------------------
   Defaults — the panel and the lib share these so the chart
   titles ("100–2000 km (50 km bins)") can never drift from the
   math behind them.
   ------------------------------------------------------------ */

export const DENSITY_ALT_MIN_KM = 100;
export const DENSITY_ALT_MAX_KM = 2000;
export const DENSITY_ALT_BIN_KM = 50;

export const DENSITY_INC_MIN_DEG = 0;
export const DENSITY_INC_MAX_DEG = 180;
export const DENSITY_INC_BIN_DEG = 5;

/**
 * The 700–1000 km shell: highest catalogued object density in LEO
 * (Cosmos 2251 / Iridium 33, Fengyun-1C fragments, decades of SL
 * rocket bodies) with atmospheric lifetimes of centuries, which is
 * why it is the band most often cited for Kessler-type cascading.
 */
export const KESSLER_BAND_KM = { from: 700, to: 1000 } as const;

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

/** One histogram bar: [from, to) plus per-class counts (sum = count). */
export interface HistogramBin {
  from: number;
  to: number;
  count: number;
  debris: number;
  payload: number;
  rocketBody: number;
  unknown: number;
}

export interface AltitudeHistogram {
  bins: HistogramBin[];
  /** Objects with a finite mean altitude below minKm (not in `total`). */
  below: number;
  /** Objects with a finite mean altitude at or above maxKm (not in `total`). */
  above: number;
  /** Objects that landed in a bin — the "LEO sample" the panel reports. */
  total: number;
  /** Bin with the highest count (first on ties); null when total is 0. */
  peak: HistogramBin | null;
  /** Objects with KESSLER_BAND_KM.from ≤ alt < KESSLER_BAND_KM.to. */
  bandCount: number;
  /** bandCount / total, or 0 when total is 0. */
  bandShare: number;
}

export interface InclinationHistogram {
  bins: HistogramBin[];
  /** Objects that landed in a bin (finite inclination in 0–180°). */
  total: number;
  /** Bin with the highest count (first on ties); null when total is 0. */
  peak: HistogramBin | null;
}

/**
 * The lib only reads these gp fields, so callers (and tests) may
 * pass partial rows. A full SpaceTrackTLE[] is of course accepted.
 */
export type AltitudeHistogramInput = Pick<
  SpaceTrackTLE,
  "APOAPSIS" | "PERIAPSIS" | "OBJECT_NAME"
>;
export type InclinationHistogramInput = Pick<
  SpaceTrackTLE,
  "INCLINATION" | "OBJECT_NAME"
>;

/* ------------------------------------------------------------
   Bin helpers
   ------------------------------------------------------------ */

export function emptyBin(from: number, to: number): HistogramBin {
  return {
    from,
    to,
    count: 0,
    debris: 0,
    payload: 0,
    rocketBody: 0,
    unknown: 0,
  };
}

/**
 * Build an empty half-open grid over [min, max) in steps of `size`.
 * The last bin is clamped to `max` when the range is not an exact
 * multiple of the step. Returns [] for non-finite or degenerate
 * parameters so callers never divide by zero or loop forever.
 */
export function makeBins(min: number, max: number, size: number): HistogramBin[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(size)) {
    return [];
  }
  if (!(size > 0) || !(max > min)) return [];
  // 1e-9 guards against 38.000000000001 → 39 from floating-point noise.
  const n = Math.ceil((max - min) / size - 1e-9);
  const bins: HistogramBin[] = [];
  for (let i = 0; i < n; i++) {
    const from = min + i * size;
    const to = Math.min(from + size, max);
    bins.push(emptyBin(from, to));
  }
  return bins;
}

/** Index of the half-open bin holding `value`; -1 when outside the grid. */
function binIndex(value: number, min: number, size: number, n: number): number {
  const i = Math.floor((value - min) / size);
  if (!Number.isFinite(i) || i < 0 || i >= n) return -1;
  return i;
}

/** Add one object of class `cls` to a bin (mutates). */
function tally(bin: HistogramBin, cls: ObjectClass): void {
  bin.count += 1;
  switch (cls) {
    case "DEBRIS":
      bin.debris += 1;
      break;
    case "PAYLOAD":
      bin.payload += 1;
      break;
    case "ROCKET BODY":
      bin.rocketBody += 1;
      break;
    default:
      bin.unknown += 1;
      break;
  }
}

/**
 * Bin with the highest count. Ties resolve to the FIRST (lowest)
 * bin so the result is deterministic. null when every bin is empty.
 */
export function peakBin(bins: readonly HistogramBin[]): HistogramBin | null {
  let best: HistogramBin | null = null;
  for (const bin of bins) {
    if (bin.count > 0 && (best === null || bin.count > best.count)) {
      best = bin;
    }
  }
  return best;
}

/* ------------------------------------------------------------
   Histogram builders
   ------------------------------------------------------------ */

/**
 * Objects per mean-altitude bin over [minKm, maxKm) (defaults:
 * 100–2000 km in 50 km bins → 38 bins). Rows whose APOAPSIS or
 * PERIAPSIS is not a finite number are skipped and counted
 * nowhere; finite rows outside the range go to `below` / `above`.
 */
export function buildAltitudeHistogram(
  objects: readonly AltitudeHistogramInput[],
  minKm: number = DENSITY_ALT_MIN_KM,
  maxKm: number = DENSITY_ALT_MAX_KM,
  binKm: number = DENSITY_ALT_BIN_KM
): AltitudeHistogram {
  const bins = makeBins(minKm, maxKm, binKm);
  let below = 0;
  let above = 0;
  let total = 0;
  let bandCount = 0;

  if (bins.length > 0) {
    for (const o of objects) {
      const alt = meanAltitudeKm(o);
      if (!Number.isFinite(alt)) continue;
      if (alt < minKm) {
        below += 1;
        continue;
      }
      if (alt >= maxKm) {
        above += 1;
        continue;
      }
      const i = binIndex(alt, minKm, binKm, bins.length);
      if (i < 0) continue; // unreachable after the range checks; FP guard only
      tally(bins[i], classifyObjectName(o.OBJECT_NAME));
      total += 1;
      if (alt >= KESSLER_BAND_KM.from && alt < KESSLER_BAND_KM.to) {
        bandCount += 1;
      }
    }
  }

  return {
    bins,
    below,
    above,
    total,
    peak: peakBin(bins),
    bandCount,
    bandShare: total > 0 ? bandCount / total : 0,
  };
}

/**
 * Objects per inclination bin over 0–180° (default 5° → 36 bins).
 * Uses the gp INCLINATION string (parseFloat; NaN skipped). Values
 * outside 0–180° are physically impossible and are skipped; exactly
 * 180° is placed in the last bin.
 */
export function buildInclinationHistogram(
  objects: readonly InclinationHistogramInput[],
  binDeg: number = DENSITY_INC_BIN_DEG
): InclinationHistogram {
  const bins = makeBins(DENSITY_INC_MIN_DEG, DENSITY_INC_MAX_DEG, binDeg);
  let total = 0;

  if (bins.length > 0) {
    for (const o of objects) {
      const inc = parseFloat(o.INCLINATION);
      if (!Number.isFinite(inc)) continue;
      if (inc < DENSITY_INC_MIN_DEG || inc > DENSITY_INC_MAX_DEG) continue;
      let i = binIndex(inc, DENSITY_INC_MIN_DEG, binDeg, bins.length);
      if (i < 0) {
        // Only exactly 180° reaches here (floor → n); fold it into the last bin.
        if (inc >= DENSITY_INC_MAX_DEG) i = bins.length - 1;
        else continue;
      }
      tally(bins[i], classifyObjectName(o.OBJECT_NAME));
      total += 1;
    }
  }

  return { bins, total, peak: peakBin(bins) };
}
