import type { SatRec } from "satellite.js";
import type { SpaceTrackCDM, SpaceTrackTLE } from "@/lib/spacetrack";
import type { ObserverSite } from "@/lib/orbital";
import {
  ISS_NORAD_ID,
  ISS_PC_RED_THRESHOLD,
  ISS_PC_YELLOW_THRESHOLD,
  geodeticFromEci,
  lookAngles,
  propagateAt,
} from "@/lib/orbital";

/* ============================================================
   SpaceDebris — ISS TOPO Console helpers (Session 5, Feature 3)

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic.
   Runs identically in the browser (components/IssConsole.tsx) and
   on the Node runtime (app/api/iss/route.ts). All propagation goes
   through lib/orbital.ts, which already guards the satellite.js
   5.0.0 quirks (array return on SGP4 error, raw ndot field).

   What lives here
   - IssStatus          : the GET /api/iss response contract.
   - groundTrack()      : sub-satellite points ±N minutes around a
                          centre time (SGP4 → TEME → geodetic).
   - predictPasses()    : geometric passes over a ground site,
                          AOS / LOS / max-elevation, chronological.
   - assessIssCdm()     : RED / YELLOW / GREEN against the NASA ISS
                          conjunction-assessment Pc thresholds.
   - isIssCdm()         : does a public CDM involve NORAD 25544?
   - Small formatting helpers shared by the console (compass
                          points, lat/lon strings, seam splitting).

   Terminology (NASA TOPO / CARA usage)
   - AOS / LOS : acquisition / loss of signal — here the instants
                 the ISS rises above / sets below the minimum
                 elevation mask as seen from the site.
   - TCA       : time of closest approach (from the CDM).
   - Pc        : probability of collision (from the CDM).
   - DAM/PDAM  : (pre-determined) debris avoidance manoeuvre —
                 planned when Pc ≥ the RED threshold.

   Assumptions stated on screen by the console
   - Passes are GEOMETRIC (elevation ≥ mask). Visibility — a
     sunlit ISS over a dark site — is NOT evaluated.
   - Positions come from SGP4 on the public element set; error is
     of order 1 km and grows with element-set age.
   ============================================================ */

/* ------------------------------------------------------------
   Types — API contract for GET /api/iss
   ------------------------------------------------------------ */

/** Response body of GET /api/iss (HTTP 200 even if ONE source failed). */
export interface IssStatus {
  /** Latest ISS element set, or null if Space-Track returned none. */
  tle: SpaceTrackTLE | null;
  /** Public CDMs involving NORAD 25544, unsorted. Empty = NOMINAL. */
  cdms: SpaceTrackCDM[];
  /** ISO timestamp of the server fetch. */
  fetchedAt: string;
  /** Per-source failure detail (absent key = source succeeded). */
  errors: { tle?: string; cdms?: string };
}

/** One sub-satellite point of the ground track. */
export interface GroundTrackPoint {
  latitudeDeg: number;
  longitudeDeg: number; // normalized to [-180, 180]
  /** Negative = past, positive = future, 0 = the centre instant. */
  minutesFromCenter: number;
}

/** One geometric pass of the satellite over a ground site. */
export interface PassPrediction {
  aos: string; // ISO — rises above the elevation mask
  los: string; // ISO — sets below the elevation mask
  maxElevationTime: string; // ISO
  maxElevationDeg: number;
  aosAzimuthDeg: number; // 0-360 clockwise from north
  losAzimuthDeg: number; // 0-360 clockwise from north
  durationSeconds: number;
}

/** NASA ISS conjunction-assessment colour (see thresholds in lib/orbital). */
export type IssCaLevel = "RED" | "YELLOW" | "GREEN";

/** A public CDM interpreted against the ISS CA thresholds. */
export interface IssCdmAssessment {
  cdm: SpaceTrackCDM;
  level: IssCaLevel;
  /** Probability of collision from the CDM, or null if not finite. */
  pc: number | null;
  /** Miss distance (MIN_RNG, km) from the CDM, or null if not finite. */
  missKm: number | null;
  /** The non-ISS object in the message. */
  otherName: string;
  otherId: string;
}

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/** Default pass-prediction window (hours). */
export const PASS_WINDOW_HOURS = 24;
/** Default coarse time step for pass search (seconds). */
export const PASS_STEP_SECONDS = 20;
/** Default elevation mask for a "pass" (degrees). */
export const PASS_MIN_ELEVATION_DEG = 10;
/** Default ground-track span (minutes each side of centre) ≈ half an ISS orbit. */
export const GROUND_TRACK_MINUTES = 46;
/** Default ground-track sampling step (seconds). */
export const GROUND_TRACK_STEP_SECONDS = 60;

/** Catalogue name used when the TLE has not loaded yet. */
export const ISS_DISPLAY_NAME = "ISS (ZARYA)";

/**
 * How many of the soonest-TCA public CDMs GET /api/iss pulls from
 * cdm_public (fetchConjunctions has no per-object predicate) before
 * filtering for NORAD 25544. Shared with the console so the on-screen
 * caveat and the server limit never drift apart: an ISS CDM whose TCA
 * lies beyond the N-th soonest message in the catalogue is NOT seen,
 * so an empty list means "none within this window", not "none exist".
 */
export const ISS_CDM_SCAN_LIMIT = 100;

/**
 * How far back from `start` predictPasses() will search for the AOS
 * of a pass that is already in progress (minutes). Longer than any
 * physically possible ISS pass (~11 min), with margin.
 */
const IN_PROGRESS_LOOKBACK_MINUTES = 20;
/** Bisection iterations for AOS / LOS refinement (20 s → < 0.1 s). */
const CROSSING_REFINE_ITERATIONS = 8;

/* ------------------------------------------------------------
   Ground track
   ------------------------------------------------------------ */

/**
 * Sub-satellite points from `center − minutesBack` to
 * `center + minutesForward`, inclusive, every `stepSeconds`.
 * Steps where SGP4 fails are skipped (never NaN in the output).
 *
 * Defaults (46 + 46 min at 60 s) give 93 points — roughly one full
 * ISS orbit centred on "now".
 */
export function groundTrack(
  satrec: SatRec,
  center: Date,
  minutesBack: number = GROUND_TRACK_MINUTES,
  minutesForward: number = GROUND_TRACK_MINUTES,
  stepSeconds: number = GROUND_TRACK_STEP_SECONDS
): GroundTrackPoint[] {
  const points: GroundTrackPoint[] = [];
  const centerMs = center.getTime();
  if (!Number.isFinite(centerMs)) return points;
  const back = Number.isFinite(minutesBack) ? Math.max(0, minutesBack) : 0;
  const fwd = Number.isFinite(minutesForward) ? Math.max(0, minutesForward) : 0;
  const step = Number.isFinite(stepSeconds) && stepSeconds > 0 ? stepSeconds : 60;

  const startS = -back * 60;
  const endS = fwd * 60;
  // Tiny epsilon so the final (forward) endpoint is included despite
  // floating-point accumulation.
  for (let s = startS; s <= endS + 1e-6; s += step) {
    const date = new Date(centerMs + s * 1000);
    const sv = propagateAt(satrec, date);
    if (!sv) continue;
    const gd = geodeticFromEci(sv.position, date);
    if (!Number.isFinite(gd.latitudeDeg) || !Number.isFinite(gd.longitudeDeg)) {
      continue;
    }
    points.push({
      latitudeDeg: gd.latitudeDeg,
      longitudeDeg: gd.longitudeDeg,
      minutesFromCenter: s / 60,
    });
  }
  return points;
}

/**
 * Split a track into polyline segments wherever consecutive points
 * jump across the ±180° seam (|Δlon| > 180), so a map renderer never
 * draws a line streaking across the whole world.
 */
export function splitTrackAtSeam<T extends { longitudeDeg: number }>(
  points: readonly T[]
): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      if (Math.abs(p.longitudeDeg - prev.longitudeDeg) > 180) {
        if (current.length > 0) segments.push(current);
        current = [];
      }
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/* ------------------------------------------------------------
   Pass prediction
   ------------------------------------------------------------ */

/** Elevation (deg) of the satellite from `site` at `date`, or null on SGP4 failure. */
function elevationAt(
  satrec: SatRec,
  site: ObserverSite,
  date: Date
): number | null {
  const sv = propagateAt(satrec, date);
  if (!sv) return null;
  const la = lookAngles(site, sv.position, date);
  return Number.isFinite(la.elevationDeg) ? la.elevationDeg : null;
}

/** Azimuth (deg, 0-360) of the satellite from `site` at `date`, or null on failure. */
function azimuthAt(
  satrec: SatRec,
  site: ObserverSite,
  date: Date
): number | null {
  const sv = propagateAt(satrec, date);
  if (!sv) return null;
  const la = lookAngles(site, sv.position, date);
  return Number.isFinite(la.azimuthDeg) ? la.azimuthDeg : null;
}

/**
 * Bisection between a time BELOW the mask (`belowMs`) and a time AT /
 * ABOVE it (`aboveMs`) — returns the earliest refined instant that is
 * at/above the mask. Works for both rising (below < above in time)
 * and setting (above < below in time) crossings.
 */
function refineCrossingMs(
  satrec: SatRec,
  site: ObserverSite,
  minElevationDeg: number,
  belowMs: number,
  aboveMs: number
): number {
  let lo = belowMs;
  let hi = aboveMs;
  for (let i = 0; i < CROSSING_REFINE_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const el = elevationAt(satrec, site, new Date(mid));
    if (el !== null && el >= minElevationDeg) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  // Whole milliseconds so ISO strings and durationSeconds agree exactly.
  return Math.round(hi);
}

/**
 * Geometric passes of `satrec` over `site` starting at `start`, for
 * `hours`, sampling every `stepSeconds` and using an elevation mask
 * of `minElevationDeg`. A pass = contiguous samples with elevation ≥
 * mask. AOS / LOS are bisection-refined to sub-second accuracy; the
 * max-elevation sample is refined with a 1 s scan around the coarse
 * maximum.
 *
 * In-progress handling: if the satellite is already above the mask
 * at `start`, the pass is included (AOS found by stepping backward
 * up to 20 min) UNLESS it sets within the first step — that tail is
 * ignored. The backward walk also tracks the running maximum, so a
 * pass joined AFTER culmination still reports its true peak rather
 * than the current (descending) elevation. A pass still in progress
 * at the window end is carried to its LOS (bounded) rather than
 * truncated.
 *
 * Returns a chronological, non-overlapping list.
 */
export function predictPasses(
  satrec: SatRec,
  site: ObserverSite,
  start: Date,
  hours: number = PASS_WINDOW_HOURS,
  stepSeconds: number = PASS_STEP_SECONDS,
  minElevationDeg: number = PASS_MIN_ELEVATION_DEG
): PassPrediction[] {
  const passes: PassPrediction[] = [];
  const startMs = start.getTime();
  if (!Number.isFinite(startMs)) return passes;
  const spanHours = Number.isFinite(hours) && hours > 0 ? hours : PASS_WINDOW_HOURS;
  const stepMs =
    Number.isFinite(stepSeconds) && stepSeconds > 0
      ? stepSeconds * 1000
      : PASS_STEP_SECONDS * 1000;
  const mask = Number.isFinite(minElevationDeg) ? minElevationDeg : PASS_MIN_ELEVATION_DEG;

  const windowEndMs = startMs + spanHours * 3_600_000;
  // Let an in-progress pass at the window edge run to its LOS.
  const hardEndMs = windowEndMs + IN_PROGRESS_LOOKBACK_MINUTES * 60_000;

  // ---- Pass accumulator ----
  let inPass = false;
  let aosMs = 0;
  let lastAboveMs = 0;
  let lastBelowMs = startMs - stepMs; // only meaningful once inPass
  let maxEl = -Infinity;
  let maxElMs = 0;

  const closePass = (losMs: number): void => {
    if (!(losMs > aosMs) || !Number.isFinite(maxElMs)) {
      inPass = false;
      return;
    }
    // Refine the max around the coarse best sample (1 s resolution).
    const scanFrom = Math.max(aosMs, maxElMs - stepMs);
    const scanTo = Math.min(losMs, maxElMs + stepMs);
    let bestEl = maxEl;
    let bestMs = maxElMs;
    for (let t = scanFrom; t <= scanTo; t += 1000) {
      const el = elevationAt(satrec, site, new Date(t));
      if (el !== null && el > bestEl) {
        bestEl = el;
        bestMs = t;
      }
    }
    // Keep the max strictly inside (AOS, LOS).
    if (bestMs <= aosMs) bestMs = Math.min(losMs - 1, aosMs + 1);
    if (bestMs >= losMs) bestMs = Math.max(aosMs + 1, losMs - 1);

    const aosAz = azimuthAt(satrec, site, new Date(aosMs));
    const losAz = azimuthAt(satrec, site, new Date(losMs));

    passes.push({
      aos: new Date(aosMs).toISOString(),
      los: new Date(losMs).toISOString(),
      maxElevationTime: new Date(bestMs).toISOString(),
      maxElevationDeg: Number.isFinite(bestEl) ? bestEl : mask,
      aosAzimuthDeg: aosAz ?? 0,
      losAzimuthDeg: losAz ?? 0,
      durationSeconds: (losMs - aosMs) / 1000,
    });
    inPass = false;
  };

  // ---- Handle a pass already in progress at `start` ----
  const elStart = elevationAt(satrec, site, start);
  let t = startMs;
  if (elStart !== null && elStart >= mask) {
    const elNext = elevationAt(satrec, site, new Date(startMs + stepMs));
    if (elNext === null || elNext < mask) {
      // Ends within the first step — ignore this tail.
      t = startMs + stepMs;
    } else {
      // Walk backward to find the true AOS (bounded). Track the running
      // maximum on the way: when `start` is after culmination the peak
      // lies in this backward leg, and seeding maxEl with elStart alone
      // would report the current (descending) elevation as the max.
      const lookbackLimit = startMs - IN_PROGRESS_LOOKBACK_MINUTES * 60_000;
      let above = startMs;
      let below = startMs - stepMs;
      let found = false;
      maxEl = elStart;
      maxElMs = startMs;
      while (below >= lookbackLimit) {
        const el = elevationAt(satrec, site, new Date(below));
        if (el === null || el < mask) {
          found = true;
          break;
        }
        if (el > maxEl) {
          maxEl = el;
          maxElMs = below;
        }
        above = below;
        below -= stepMs;
      }
      aosMs = found ? refineCrossingMs(satrec, site, mask, below, above) : above;
      inPass = true;
      lastAboveMs = startMs;
      t = startMs + stepMs;
    }
  }

  // ---- Main forward scan ----
  for (; t <= hardEndMs; t += stepMs) {
    // Outside the nominal window only continue if we are finishing a pass.
    if (t > windowEndMs && !inPass) break;

    const date = new Date(t);
    const el = elevationAt(satrec, site, date);
    const above = el !== null && el >= mask;

    if (above) {
      if (!inPass) {
        inPass = true;
        aosMs = refineCrossingMs(satrec, site, mask, lastBelowMs, t);
        maxEl = -Infinity;
        maxElMs = t;
      }
      lastAboveMs = t;
      // el is non-null here because `above` is true.
      if (el !== null && el > maxEl) {
        maxEl = el;
        maxElMs = t;
      }
    } else {
      if (inPass) {
        const losMs = refineCrossingMs(satrec, site, mask, t, lastAboveMs);
        closePass(losMs);
      }
      lastBelowMs = t;
    }
  }

  // A pass still open at the hard end: close it at the last sample.
  if (inPass) {
    closePass(lastAboveMs);
  }

  passes.sort((a, b) => Date.parse(a.aos) - Date.parse(b.aos));
  return passes;
}

/* ------------------------------------------------------------
   CDM assessment
   ------------------------------------------------------------ */

/** Trim + strip leading zeros so " 25544" and "025544" both match. */
function normalizeNoradId(id: string | null | undefined): string {
  if (typeof id !== "string") return "";
  const t = id.trim();
  if (/^\d+$/.test(t)) return String(parseInt(t, 10));
  return t;
}

/** True if either object in the CDM is the ISS (NORAD 25544). */
export function isIssCdm(cdm: SpaceTrackCDM): boolean {
  if (!cdm || typeof cdm !== "object") return false;
  return (
    normalizeNoradId(cdm.SAT_1_ID) === ISS_NORAD_ID ||
    normalizeNoradId(cdm.SAT_2_ID) === ISS_NORAD_ID
  );
}

/** parseFloat with a finite guard → number | null. */
function finiteOrNull(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Classify a public CDM against the NASA ISS CA thresholds:
 *   RED    : Pc ≥ ISS_PC_RED_THRESHOLD   (DAM / PDAM planning)
 *   YELLOW : Pc ≥ ISS_PC_YELLOW_THRESHOLD
 *   GREEN  : otherwise (including a missing / non-finite Pc)
 * otherName / otherId are whichever object is not NORAD 25544.
 */
export function assessIssCdm(cdm: SpaceTrackCDM): IssCdmAssessment {
  const pc = finiteOrNull(cdm.PC);
  const missKm = finiteOrNull(cdm.MIN_RNG);

  let level: IssCaLevel = "GREEN";
  if (pc !== null && pc >= ISS_PC_RED_THRESHOLD) level = "RED";
  else if (pc !== null && pc >= ISS_PC_YELLOW_THRESHOLD) level = "YELLOW";

  const sat1IsIss = normalizeNoradId(cdm.SAT_1_ID) === ISS_NORAD_ID;
  const otherIdRaw = sat1IsIss ? cdm.SAT_2_ID : cdm.SAT_1_ID;
  const otherNameRaw = sat1IsIss ? cdm.SAT_2_NAME : cdm.SAT_1_NAME;
  const otherId = normalizeNoradId(otherIdRaw) || "UNKNOWN";
  const otherName =
    typeof otherNameRaw === "string" && otherNameRaw.trim().length > 0
      ? otherNameRaw.trim()
      : `NORAD ${otherId}`;

  return { cdm, level, pc, missKm, otherName, otherId };
}

/** Worst of a set of levels (RED > YELLOW > GREEN); GREEN for an empty list. */
export function worstIssCaLevel(levels: readonly IssCaLevel[]): IssCaLevel {
  if (levels.includes("RED")) return "RED";
  if (levels.includes("YELLOW")) return "YELLOW";
  return "GREEN";
}

/**
 * Parse a Space-Track timestamp as UTC → epoch ms, or null.
 *
 * Space-Track emits "2024-01-02T00:00:00.000" or "2024-01-02 00:00:00"
 * with NO zone designator. JavaScript's Date.parse treats a zone-less
 * date-time as LOCAL time, which would shift every TCA by the viewer's
 * UTC offset. All Space-Track times are UTC, so we append "Z" when no
 * designator is present. Strings that already carry Z / ±hh:mm are
 * parsed as-is.
 */
export function parseUtcTimestamp(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;
  // "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DDTHH:MM:SS"
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  if (!hasZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Sort CDMs by TCA ascending; unparseable TCAs sink to the end
 * (stable with respect to each other).
 */
export function sortCdmsByTca(cdms: readonly SpaceTrackCDM[]): SpaceTrackCDM[] {
  const keyed = cdms.map((c, i) => {
    const t = parseUtcTimestamp(c.TCA);
    return { c, i, t: t === null ? Number.POSITIVE_INFINITY : t };
  });
  keyed.sort((a, b) => (a.t === b.t ? a.i - b.i : a.t - b.t));
  return keyed.map((k) => k.c);
}

/* ------------------------------------------------------------
   Formatting helpers (shared by the console; pure + testable)
   ------------------------------------------------------------ */

const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** 8-point compass direction for an azimuth in degrees (any range). */
export function compassPoint(azimuthDeg: number): CompassPoint {
  if (!Number.isFinite(azimuthDeg)) return "N";
  const norm = ((azimuthDeg % 360) + 360) % 360;
  const idx = Math.round(norm / 45) % 8;
  return COMPASS_POINTS[idx];
}

/** "51.46° N" / "12.00° S"; "—" for a non-finite input. */
export function formatLatitude(latDeg: number, decimals = 2): string {
  if (!Number.isFinite(latDeg)) return "—";
  const hemi = latDeg >= 0 ? "N" : "S";
  return `${Math.abs(latDeg).toFixed(decimals)}° ${hemi}`;
}

/** "27.13° E" / "95.09° W"; "—" for a non-finite input. */
export function formatLongitude(lonDeg: number, decimals = 2): string {
  if (!Number.isFinite(lonDeg)) return "—";
  const hemi = lonDeg >= 0 ? "E" : "W";
  return `${Math.abs(lonDeg).toFixed(decimals)}° ${hemi}`;
}

/**
 * Pc threshold as a compact exponent string ("1e-4", "1e-5") so the
 * UI legend is built from the lib/orbital constants, not typed digits.
 */
export function formatPcThreshold(pc: number): string {
  if (!Number.isFinite(pc) || pc <= 0) return "n/a";
  return pc.toExponential(0); // 1e-4 → "1e-4"
}

/** Pc for display: "3.2e-5", or "n/a" when the CDM carries none. */
export function formatPc(pc: number | null): string {
  if (pc === null || !Number.isFinite(pc)) return "n/a";
  return pc.toExponential(1);
}

/**
 * Age of an element set in hours at `nowMs` (negative if the epoch is
 * in the future, which Space-Track occasionally publishes). NaN-safe.
 */
export function tleAgeHours(epoch: Date, nowMs: number): number | null {
  const e = epoch.getTime();
  if (!Number.isFinite(e) || !Number.isFinite(nowMs)) return null;
  return (nowMs - e) / 3_600_000;
}
