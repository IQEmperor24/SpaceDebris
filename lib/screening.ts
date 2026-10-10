import type { SatRec } from "satellite.js";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import type {
  ScreeningAssumptions,
  ScreeningCloseApproach,
  ScreeningResult,
  ScreeningTarget,
  ThreatLevel,
} from "@/lib/prompts";
import {
  EARTH_EQUATORIAL_RADIUS_KM,
  ISS_KEEP_OUT_BOX_KM,
  MU_EARTH_KM3_S2,
  altitudeKmFromEci,
  classifyObjectName,
  minutesSinceEpoch,
  parseTle,
  probabilityOfCollision,
  propagateMinutes,
  ricFrame,
  tleElements,
  toRic,
  vNorm,
  vSub,
  type StateVector,
  type Vec3,
} from "@/lib/orbital";

/* ============================================================
   SpaceDebris — SGP4 conjunction screening engine (deterministic)

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic. Runs
   identically on the Node runtime (GET /api/screen) and in the
   browser. Every physics helper comes from lib/orbital.ts — this
   file only orchestrates the all-on-one search.

   What "screening" means here (CARA / 18 SDS vocabulary)
   - TARGET  = the primary object the operator cares about.
   - SAMPLE  = the Space-Track gp sample (≈2,000 newest element
               sets) the target is screened against.
   - TCA     = time of closest approach, found per candidate.
   - RIC     = the target's radial / in-track / cross-track frame;
               the secondary's position relative to the target is
               reported in that frame at TCA.
   - Pc      = probability of collision under an ASSUMED per-object
               TLE-grade covariance (σ RIC, 1-σ, km) and a stated
               combined hard-body radius. It is an ESTIMATE, not an
               operator-covariance Pc and not a CDM value.

   Algorithm
   1. Parse the target TLE (throws if unparseable) and derive its
      elements for the ScreeningTarget strip.
   2. Prefilter: keep sample objects whose [perigee − band, apogee
      + band] overlaps the target's [perigee, apogee]. Objects that
      never share an altitude shell cannot approach. Sorted by
      |mean-altitude difference| and capped at maxCandidates.
   3. Precompute the target's ECI position at every coarse step
      (default 60 s) over the window into flat Float64Arrays.
   4. For each candidate: walk the coarse grid, compute separation
      d_k, and detect interior local minima
        d[k-1] < d[k-2] && d[k-1] <= d[k] && d[k-1] < gateKm
      where gateKm = reportThresholdKm + vMaxRel × step / 2 — the
      distance a true sub-threshold minimum can grow to by the
      nearest grid sample at the maximum relative speed. Each
      detected minimum is refined by golden-section search over
      [t_{k-2}, t_k] to 0.05 s (both objects re-propagated per
      evaluation). Only the single closest refined approach per
      candidate is kept — co-orbital objects would otherwise
      produce one row per revolution.
      Performance: between samples we skip ahead by
      floor((d − gate) / (vBound × step)) grid points, where
      vBound = v_escape(target perigee) + v_escape(candidate
      perigee) is a rigorous upper bound on relative speed for two
      bound orbits. Skipped points provably lie above the gate, so
      they could never host a reportable minimum — the result set
      is identical to a dense walk, it just arrives faster.
   5. Approaches with miss ≤ reportThresholdKm are reported with
      TCA, miss, relative velocity, RIC components, target altitude,
      Pc, keep-out-box penetration (NASA ISS "pizza box"), object
      class and a severity grade; sorted by miss ascending and
      capped at maxResults.

   Severity grades (screener-side, deterministic)
   - CRITICAL: Pc ≥ 1e-4 (NASA ISS RED threshold) or miss < 1 km
   - HIGH:     Pc ≥ 1e-5 (YELLOW threshold) or inside keep-out box
   - MEDIUM:   miss < 10 km
   - LOW:      everything else below the reporting threshold

   Known limits (state them on screen, never hide them)
   - SGP4 on public TLEs: ~1 km positional error at epoch, growing
     with element-set age; in-track is the least reliable axis.
   - The Pc model is the short-encounter (Foster/Alfano) 2-D
     integral. For co-orbital encounters (relative speed ≲ 0.1
     km/s) the straight-line relative-motion assumption breaks down
     and Pc should be read as indicative only.
   - A time budget (default 20 s) may stop the walk early; the
     result then carries truncated = true and the UI must say so.
   ============================================================ */

/* ------------------------------------------------------------
   Options
   ------------------------------------------------------------ */

export interface ScreeningOptions {
  /** Screening window length (h) starting at `start`. */
  windowHours: number;
  /** Coarse grid spacing (s). */
  coarseStepSeconds: number;
  /** Only approaches with miss ≤ this are reported (km). */
  reportThresholdKm: number;
  /** Max rows in the result (closest first). */
  maxResults: number;
  /** Max candidates propagated after the altitude prefilter. */
  maxCandidates: number;
  /** Altitude band added around candidate perigee/apogee for the prefilter (km). */
  altitudeBandKm: number;
  /** Wall-clock budget; the walk stops (truncated = true) when exceeded. */
  timeBudgetMs: number;
  /** Assumed per-object 1-σ position uncertainty in RIC (km). */
  sigmaRicKm: [number, number, number];
  /** Combined hard-body radius (m). */
  hardBodyRadiusM: number;
}

export const DEFAULT_SCREENING_OPTIONS: ScreeningOptions = {
  windowHours: 24,
  coarseStepSeconds: 60,
  reportThresholdKm: 50,
  maxResults: 15,
  maxCandidates: 1500,
  altitudeBandKm: 75,
  timeBudgetMs: 20000,
  sigmaRicKm: [0.3, 1.0, 0.3],
  hardBodyRadiusM: 20,
};

/** Window lengths the API and UI accept (hours). */
export const SCREENING_WINDOW_OPTIONS: readonly number[] = [6, 12, 24, 48];

/**
 * Nominal maximum relative speed between two Earth-orbiting objects
 * used to size the coarse-grid gate (two LEO objects head-on ≈ 15.6
 * km/s). The per-pair skip bound below is stricter and derived from
 * escape speeds, so this only affects how many minima get refined.
 */
export const MAX_RELATIVE_SPEED_KM_S = 16;

/** Golden-section bracket tolerance (s). */
const REFINE_TOLERANCE_S = 0.05;

/** Safety margin on the rigorous relative-speed bound used for skipping. */
const SKIP_BOUND_MARGIN = 1.05;

/** Hard cap on coarse-grid samples so a bad option set cannot exhaust memory. */
const MAX_GRID_SAMPLES = 1_000_000;

/* ------------------------------------------------------------
   Internal types
   ------------------------------------------------------------ */

interface Candidate {
  tle: SpaceTrackTLE;
  noradId: string;
  meanAltKm: number;
  perigeeKm: number;
  /** Set when the prefilter already had to parse the TLE. */
  satrec: SatRec | null;
}

interface RefinedApproach {
  /** Seconds after `start`. */
  tSec: number;
  missKm: number;
  target: StateVector;
  secondary: StateVector;
}

/* ------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------ */

function nowMs(): number {
  const p = globalThis.performance;
  return p && typeof p.now === "function" ? p.now() : Date.now();
}

function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Escape speed at a geocentric radius (km/s) — upper bound on orbital speed there. */
function escapeSpeedKmS(radiusKm: number): number {
  const r = Math.max(radiusKm, EARTH_EQUATORIAL_RADIUS_KM);
  return Math.sqrt((2 * MU_EARTH_KM3_S2) / r);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function resolveOptions(partial?: Partial<ScreeningOptions>): ScreeningOptions {
  const o: ScreeningOptions = { ...DEFAULT_SCREENING_OPTIONS, ...(partial ?? {}) };
  const d = DEFAULT_SCREENING_OPTIONS;
  const windowHours = finiteOr(o.windowHours, d.windowHours);
  const coarseStepSeconds = finiteOr(o.coarseStepSeconds, d.coarseStepSeconds);
  const sigma = Array.isArray(o.sigmaRicKm) && o.sigmaRicKm.length === 3
    ? o.sigmaRicKm
    : d.sigmaRicKm;
  return {
    windowHours: windowHours > 0 ? windowHours : d.windowHours,
    coarseStepSeconds: coarseStepSeconds >= 1 ? coarseStepSeconds : d.coarseStepSeconds,
    reportThresholdKm: Math.max(0, finiteOr(o.reportThresholdKm, d.reportThresholdKm)),
    maxResults: Math.max(1, Math.floor(finiteOr(o.maxResults, d.maxResults))),
    maxCandidates: Math.max(1, Math.floor(finiteOr(o.maxCandidates, d.maxCandidates))),
    altitudeBandKm: Math.max(0, finiteOr(o.altitudeBandKm, d.altitudeBandKm)),
    timeBudgetMs: Math.max(1, finiteOr(o.timeBudgetMs, d.timeBudgetMs)),
    sigmaRicKm: [
      Math.max(0, finiteOr(sigma[0], d.sigmaRicKm[0])),
      Math.max(0, finiteOr(sigma[1], d.sigmaRicKm[1])),
      Math.max(0, finiteOr(sigma[2], d.sigmaRicKm[2])),
    ],
    hardBodyRadiusM: Math.max(0, finiteOr(o.hardBodyRadiusM, d.hardBodyRadiusM)),
  };
}

/* ------------------------------------------------------------
   Severity grading
   ------------------------------------------------------------ */

export function gradeSeverity(
  probabilityOfCollisionValue: number,
  missDistanceKm: number,
  insideKeepOutBox: boolean
): ThreatLevel {
  if (probabilityOfCollisionValue >= 1e-4 || missDistanceKm < 1) return "CRITICAL";
  if (probabilityOfCollisionValue >= 1e-5 || insideKeepOutBox) return "HIGH";
  if (missDistanceKm < 10) return "MEDIUM";
  return "LOW";
}

/* ------------------------------------------------------------
   Prefilter
   ------------------------------------------------------------ */

function buildCandidates(
  target: SpaceTrackTLE,
  targetId: string,
  targetPerigeeKm: number,
  targetApogeeKm: number,
  targetMeanAltKm: number,
  sample: SpaceTrackTLE[],
  options: ScreeningOptions
): Candidate[] {
  const band = options.altitudeBandKm;
  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const c of sample) {
    if (!c || typeof c.TLE_LINE1 !== "string" || typeof c.TLE_LINE2 !== "string") {
      continue;
    }
    const id = typeof c.NORAD_CAT_ID === "string" ? c.NORAD_CAT_ID.trim() : "";
    if (id && id === targetId) continue;
    // Same element set under any ID → trivially zero separation; skip.
    if (c.TLE_LINE1 === target.TLE_LINE1 && c.TLE_LINE2 === target.TLE_LINE2) continue;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }

    let peri = parseFloat(c.PERIAPSIS);
    let apo = parseFloat(c.APOAPSIS);
    let satrec: SatRec | null = null;
    if (!Number.isFinite(peri) || !Number.isFinite(apo)) {
      satrec = parseTle(c.TLE_LINE1, c.TLE_LINE2);
      if (!satrec) continue;
      const el = tleElements(c, satrec);
      if (!el) continue;
      peri = el.perigeeKm;
      apo = el.apogeeKm;
      if (!Number.isFinite(peri) || !Number.isFinite(apo)) continue;
    }
    if (peri > apo) {
      const tmp = peri;
      peri = apo;
      apo = tmp;
    }

    // Overlap test: [peri − band, apo + band] ∩ [tPeri, tApo] ≠ ∅
    if (peri - band > targetApogeeKm || apo + band < targetPerigeeKm) continue;

    out.push({
      tle: c,
      noradId: id,
      meanAltKm: (peri + apo) / 2,
      perigeeKm: peri,
      satrec,
    });
  }

  out.sort(
    (a, b) =>
      Math.abs(a.meanAltKm - targetMeanAltKm) -
      Math.abs(b.meanAltKm - targetMeanAltKm)
  );
  return out.slice(0, options.maxCandidates);
}

/* ------------------------------------------------------------
   Refinement (golden-section search on separation)
   ------------------------------------------------------------ */

interface Propagator {
  targetSatrec: SatRec;
  targetMin0: number;
  secondarySatrec: SatRec;
  secondaryMin0: number;
  /** Mutable propagation counter shared with the caller. */
  count: { n: number };
}

/** Separation at `tSec` after start; both states returned (null on SGP4 failure). */
function evaluate(
  p: Propagator,
  tSec: number
): { missKm: number; target: StateVector; secondary: StateVector } | null {
  const minutes = tSec / 60;
  const t = propagateMinutes(p.targetSatrec, p.targetMin0 + minutes);
  p.count.n++;
  if (!t) return null;
  const s = propagateMinutes(p.secondarySatrec, p.secondaryMin0 + minutes);
  p.count.n++;
  if (!s) return null;
  return { missKm: distance(s.position, t.position), target: t, secondary: s };
}

function refineMinimum(
  p: Propagator,
  aSec: number,
  bSec: number
): RefinedApproach | null {
  const gr = (Math.sqrt(5) - 1) / 2; // 0.618…
  let a = aSec;
  let b = bSec;
  let best: RefinedApproach | null = null;

  const consider = (tSec: number): number => {
    const e = evaluate(p, tSec);
    if (!e) return Number.POSITIVE_INFINITY;
    if (!best || e.missKm < best.missKm) {
      best = { tSec, missKm: e.missKm, target: e.target, secondary: e.secondary };
    }
    return e.missKm;
  };

  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = consider(c);
  let fd = consider(d);

  // ~17 iterations for a 120 s bracket at 0.05 s tolerance.
  let guard = 0;
  while (b - a > REFINE_TOLERANCE_S && guard < 200) {
    guard++;
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = consider(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = consider(d);
    }
  }
  // Final midpoint evaluation (also provides the states at TCA).
  consider((a + b) / 2);
  return best;
}

/* ------------------------------------------------------------
   Main entry point
   ------------------------------------------------------------ */

/**
 * Screen `target` against `sample` from `start` for options.windowHours.
 * Throws if the target TLE cannot be parsed or propagated; every
 * other failure (bad candidate rows, SGP4 errors mid-window) is
 * skipped silently so one bad catalog row never kills a run.
 */
export function screenTarget(
  target: SpaceTrackTLE,
  sample: SpaceTrackTLE[],
  start: Date,
  options?: Partial<ScreeningOptions>
): ScreeningResult {
  const t0 = nowMs();
  const opts = resolveOptions(options);

  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) {
    throw new Error("Screening start time is invalid");
  }

  // ---- 1. Target ----
  const targetSatrec = parseTle(target.TLE_LINE1, target.TLE_LINE2);
  if (!targetSatrec) throw new Error("Target TLE could not be parsed");
  const el = tleElements(target, targetSatrec);
  if (!el) throw new Error("Target TLE could not be parsed");

  const targetId =
    (typeof target.NORAD_CAT_ID === "string" && target.NORAD_CAT_ID.trim()) ||
    targetSatrec.satnum.trim();
  const targetMeanAltKm = el.semiMajorAxisKm - EARTH_EQUATORIAL_RADIUS_KM;
  const epochIso = Number.isFinite(el.epoch.getTime())
    ? el.epoch.toISOString()
    : start.toISOString();

  const screeningTarget: ScreeningTarget = {
    noradId: el.noradId,
    name: el.name,
    meanAltitudeKm: targetMeanAltKm,
    inclinationDeg: el.inclinationDeg,
    periodMinutes: el.periodMinutes,
    epoch: epochIso,
  };

  // ---- 2. Prefilter ----
  const candidates = buildCandidates(
    target,
    targetId,
    el.perigeeKm,
    el.apogeeKm,
    targetMeanAltKm,
    Array.isArray(sample) ? sample : [],
    opts
  );

  // ---- 3. Target grid ----
  const stepSec = opts.coarseStepSeconds;
  const stepMin = stepSec / 60;
  const windowSec = opts.windowHours * 3600;
  const N = Math.min(MAX_GRID_SAMPLES, Math.max(1, Math.round(windowSec / stepSec)));
  const samples = N + 1;

  const counter = { n: 0 };
  const targetMin0 = minutesSinceEpoch(targetSatrec, start);
  const tPos = new Float64Array(3 * samples);
  const tOk = new Uint8Array(samples);
  let usableSteps = 0;
  for (let k = 0; k < samples; k++) {
    const sv = propagateMinutes(targetSatrec, targetMin0 + k * stepMin);
    counter.n++;
    if (!sv) continue;
    tPos[3 * k] = sv.position[0];
    tPos[3 * k + 1] = sv.position[1];
    tPos[3 * k + 2] = sv.position[2];
    tOk[k] = 1;
    usableSteps++;
  }
  if (usableSteps === 0) {
    throw new Error("Target TLE could not be propagated over the screening window");
  }

  const gateKm = opts.reportThresholdKm + (MAX_RELATIVE_SPEED_KM_S * stepSec) / 2;
  const targetEscapeKmS = escapeSpeedKmS(el.perigeeKm + EARTH_EQUATORIAL_RADIUS_KM);
  const hardBodyRadiusKm = opts.hardBodyRadiusM / 1000;

  // ---- 4. Candidate walk ----
  const approaches: ScreeningCloseApproach[] = [];
  let candidatesScreened = 0;
  let truncated = false;
  const tPoint: Vec3 = [0, 0, 0];

  for (const cand of candidates) {
    if (nowMs() - t0 > opts.timeBudgetMs) {
      truncated = true;
      break;
    }
    const satrec = cand.satrec ?? parseTle(cand.tle.TLE_LINE1, cand.tle.TLE_LINE2);
    if (!satrec) continue;
    candidatesScreened++;

    const secondaryMin0 = minutesSinceEpoch(satrec, start);
    const vBound =
      SKIP_BOUND_MARGIN *
      (targetEscapeKmS + escapeSpeedKmS(cand.perigeeKm + EARTH_EQUATORIAL_RADIUS_KM));
    const skipDenom = vBound * stepSec;

    const propagator: Propagator = {
      targetSatrec,
      targetMin0,
      secondarySatrec: satrec,
      secondaryMin0,
      count: counter,
    };

    let best: RefinedApproach | null = null;
    // d at k-2 / k-1; +Infinity encodes "not sampled, provably above gate".
    let dPrev2 = Number.POSITIVE_INFINITY;
    let dPrev = Number.POSITIVE_INFINITY;
    let k = 0;
    while (k < samples) {
      if (!tOk[k]) {
        dPrev2 = Number.POSITIVE_INFINITY;
        dPrev = Number.POSITIVE_INFINITY;
        k++;
        continue;
      }
      const sv = propagateMinutes(satrec, secondaryMin0 + k * stepMin);
      counter.n++;
      if (!sv) {
        dPrev2 = Number.POSITIVE_INFINITY;
        dPrev = Number.POSITIVE_INFINITY;
        k++;
        continue;
      }
      tPoint[0] = tPos[3 * k];
      tPoint[1] = tPos[3 * k + 1];
      tPoint[2] = tPos[3 * k + 2];
      const d = distance(sv.position, tPoint);

      // Interior local minimum at k-1? (k >= 2 keeps the bracket inside the window.)
      if (k >= 2 && dPrev < gateKm && dPrev < dPrev2 && dPrev <= d) {
        const refined = refineMinimum(propagator, (k - 2) * stepSec, k * stepSec);
        if (refined && (!best || refined.missKm < best.missKm)) best = refined;
      }

      // Skip ahead while provably above the gate (see header).
      const skip = Math.floor((d - gateKm) / skipDenom);
      if (skip >= 2) {
        dPrev2 = Number.POSITIVE_INFINITY;
        dPrev = Number.POSITIVE_INFINITY;
        k += skip;
      } else {
        dPrev2 = dPrev;
        dPrev = d;
        k++;
      }
    }

    if (!best || !(best.missKm <= opts.reportThresholdKm)) continue;

    // ---- Build the report row ----
    const relPos = vSub(best.secondary.position, best.target.position);
    const relVel = vSub(best.secondary.velocity, best.target.velocity);
    const frame = ricFrame(best.target.position, best.target.velocity);
    const ric = toRic(relPos, frame);
    const pc = probabilityOfCollision({
      primary: {
        position: best.target.position,
        velocity: best.target.velocity,
        sigmaRicKm: opts.sigmaRicKm,
      },
      secondary: {
        position: best.secondary.position,
        velocity: best.secondary.velocity,
        sigmaRicKm: opts.sigmaRicKm,
      },
      hardBodyRadiusKm,
    });
    const insideKeepOutBox =
      Math.abs(ric.radialKm) <= ISS_KEEP_OUT_BOX_KM.radial &&
      Math.abs(ric.inTrackKm) <= ISS_KEEP_OUT_BOX_KM.inTrack &&
      Math.abs(ric.crossTrackKm) <= ISS_KEEP_OUT_BOX_KM.crossTrack;
    const name =
      typeof cand.tle.OBJECT_NAME === "string" && cand.tle.OBJECT_NAME.trim()
        ? cand.tle.OBJECT_NAME.trim()
        : `NORAD ${cand.noradId || satrec.satnum.trim()}`;

    approaches.push({
      noradId: cand.noradId || satrec.satnum.trim(),
      name,
      objectClass: classifyObjectName(cand.tle.OBJECT_NAME),
      tca: new Date(start.getTime() + best.tSec * 1000).toISOString(),
      missDistanceKm: best.missKm,
      relativeVelocityKmS: vNorm(relVel),
      radialKm: ric.radialKm,
      inTrackKm: ric.inTrackKm,
      crossTrackKm: ric.crossTrackKm,
      altitudeKm: altitudeKmFromEci(best.target.position),
      probabilityOfCollision: pc,
      insideKeepOutBox,
      severity: gradeSeverity(pc, best.missKm, insideKeepOutBox),
    });
  }

  // ---- 5. Result ----
  approaches.sort((a, b) => a.missDistanceKm - b.missDistanceKm);

  const assumptions: ScreeningAssumptions = {
    sigmaRicKm: [opts.sigmaRicKm[0], opts.sigmaRicKm[1], opts.sigmaRicKm[2]],
    hardBodyRadiusM: opts.hardBodyRadiusM,
    keepOutBoxKm: {
      radial: ISS_KEEP_OUT_BOX_KM.radial,
      inTrack: ISS_KEEP_OUT_BOX_KM.inTrack,
      crossTrack: ISS_KEEP_OUT_BOX_KM.crossTrack,
    },
    coarseStepSeconds: stepSec,
    windowHours: opts.windowHours,
  };

  return {
    target: screeningTarget,
    generatedAt: new Date().toISOString(),
    windowStart: start.toISOString(),
    windowEnd: new Date(start.getTime() + windowSec * 1000).toISOString(),
    sampleSize: Array.isArray(sample) ? sample.length : 0,
    candidatesScreened,
    propagations: counter.n,
    computeMs: Math.round(nowMs() - t0),
    truncated,
    assumptions,
    closeApproaches: approaches.slice(0, opts.maxResults),
  };
}
