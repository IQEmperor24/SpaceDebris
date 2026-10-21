import {
  MU_EARTH_KM3_S2,
  STARLINK_PC_MANEUVER_THRESHOLD,
  meanMotionRadPerSec,
  probabilityOfCollision,
  ricFrame,
  toRic,
  twoBodyPropagate,
  vAdd,
  vDot,
  vNorm,
  vScale,
  vSub,
  type RicFrame,
  type RicVector,
  type StateVector,
  type Vec3,
} from "@/lib/orbital";

/* ============================================================
   SpaceDebris — Autonomous Avoidance Planner core (Session 6)

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic. Runs
   in the browser (components/AvoidancePlanner.tsx) and under
   node --experimental-strip-types for the scratch tests.

   What it does
   Given the two ECI (TEME) states at TCA that GET /api/screen
   returns with every close approach, evaluate a trade space of
   single in-track burns on the TARGET:
       burn lead τ  ∈ {12 h … 30 min} before TCA (burn CENTROID)
       Δv           ∈ {1 … 100 cm/s}
       direction    ∈ {PROGRADE (+in-track), RETROGRADE (−in-track)}
   For each burn:
     1. Clohessy-Wiltshire (Hill) displacement of the target AT TCA
        relative to its unperturbed path, in the target's RIC frame
        at TCA. A finite constant-thrust burn is modelled EXACTLY
        within CW theory by superposition (CW is linear): the burn
        is split into 16 equal sub-impulses spread over its duration
        and centred on the lead time (cwFiniteBurnDisplacement). A
        burn shorter than 10 % of the period is effectively impulsive.
     2. Rotate to ECI with the target's RIC frame at TCA and shift
        the target position; velocity is left unchanged (O(Δv) next
        to the km/s relative speed of the encounter).
     3. Re-evaluate the encounter: miss distance = closest approach
        under straight-line relative motion (the same short-encounter
        assumption the Pc integral makes; for a head-on pass an
        in-track shift only moves the TCA, not the miss), and Pc via
        lib/orbital probabilityOfCollision under the SAME assumed
        covariance and hard-body radius the screen used.
     4. Propellant (Tsiolkovsky) and burn duration (constant thrust)
        for the selected vehicle preset.
   Feasibility: the burn must END before TCA (burn/2 < lead) and,
   when the caller passes the time remaining until TCA, must not
   START in the past (lead + burn/2 ≤ time remaining).
   Decision rule (Starlink-style, public): a maneuver is required
   when the baseline Pc ≥ STARLINK_PC_MANEUVER_THRESHOLD (1e-5).
   Candidates are the feasible cells whose CW Pc is below the
   threshold AND whose miss distance grows, walked in preference
   order: smallest Δv, then the LONGEST lead (earliest burn — most
   margin), then the lower Pc. Each candidate is re-solved on
   two-body arcs with no linearisation (evaluateBurnTwoBody), and the
   FIRST one that also clears the rule there is recommended. A cell
   that passes under CW only is flagged (twoBodyMeetsThreshold =
   false) and is never recommended. On an eccentric orbit, CW about a
   circular reference gets the encounter-plane (radial) displacement
   wrong by about e × the in-track drift (ISS osculating e ≈ 0.0013
   gives ~10 % at a 12 h lead; e = 0.03 can halve the true miss). A
   linearised pass alone is therefore never enough to recommend a burn.
   evaluateTradeGrid holds the time-independent part (the 112 CW Pc
   integrals). finalizeTradeSpace applies the time remaining and runs
   the confirmation walk, reusing the grid's two-body memo, so a
   clock tick costs almost nothing.

   CW model (verified numerically against two-body truth)
   Zero initial relative position, initial relative velocity = Δv
   (km/s) in the RIC frame at burn time; n = mean motion of the
   reference orbit, τ = lead:
     x (radial)      = (Δv_r/n)·sin nτ + (2Δv_i/n)·(1 − cos nτ)
     y (in-track)    = (2Δv_r/n)·(cos nτ − 1) + Δv_i·(4·sin(nτ)/n − 3τ)
     z (cross-track) = (Δv_c/n)·sin nτ
   Physical reading: a prograde burn raises the orbit (x = 4Δv/n half
   an orbit later) and, because the higher orbit is slower, the
   vehicle drifts BEHIND (y ≈ −3Δv_i·τ). With a crossing angle that
   secular drift is the dominant lever (5 cm/s twelve hours early
   moves the vehicle ≈ 6.5 km); head-on, only the radial term moves
   the miss distance, so far more Δv is needed.
   Scratch test (circular 550 km / 53°, Δv 5 cm/s on each axis, τ =
   0.5 / 1 / 6 / 12 h): every component agrees with Keplerian truth
   in sign and to < 2 %; the worst case (12 h radial, 1.7 %) is the
   known rectilinear-frame curvature term y²/2r (it grows with Δv²:
   ~25 % of the radial component at 0.5 m/s and 12 h).
   The live check for the screened geometry (checkLinearisation)
   therefore compares in CURVILINEAR RIC: radial = Δ|r|, and in-track
   and cross-track are arc lengths. That curvature cancels in the true
   miss, because both objects fly curved arcs. The check then projects
   the error onto the ENCOUNTER PLANE (⟂ relative velocity), the only
   part that moves the miss and Pc. A 3-D error norm would be
   dominated by the in-track drift and would hide the radial error.
   "Verified" requires an encounter-plane error ≤ CW_VALID_MAX_ERROR
   (2 %) and an osculating eccentricity ≤ CW_VALID_MAX_ECCENTRICITY.

   ASSUMPTIONS (printed on screen too)
   - In-track thrust only; constant thrust, direction held along the
     local in-track axis during the burn.
   - Circular reference orbit for CW (mean motion from the vis-viva
     semi-major axis of the target state at TCA); J2 / drag
     differential effects are not modelled.
   - Only the target maneuvers; the secondary is non-cooperative.
   - Pc uses the screen's ASSUMED TLE-grade covariance — not an
     operator covariance; its sensitivity to that assumption is
     reported (pcSensitivity / pcDilution).
   - Vehicle mass / Isp / thrust are public estimates (labelled).
   A planning aid — not flight software, not an operator product.
   ============================================================ */

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

/** Impulsive Δv in the vehicle's RIC frame at burn time (m/s). */
export interface RicDeltaV {
  radialMps: number;
  inTrackMps: number;
  crossTrackMps: number;
}

export interface VehiclePreset {
  id: string;
  label: string;
  wetMassKg: number;
  ispSeconds: number;
  thrustNewtons: number;
  note: string;
}

export type BurnDirection = "PROGRADE" | "RETROGRADE";

export interface TradeCell {
  /** Burn centroid before TCA (s). */
  leadSeconds: number;
  /** Δv magnitude (m/s); the sign is carried by `direction`. */
  dvMps: number;
  direction: BurnDirection;
  /** Closest-approach distance after the burn (km), straight-line relative motion. */
  missKm: number;
  pc: number;
  /** Target displacement at TCA vs its unperturbed path, target RIC at TCA (km). */
  ricKm: RicVector;
  propellantKg: number;
  burnSeconds: number;
  /**
   * feasible AND (CW) pc < thresholdPc AND missKm > baseline.missKm.
   * Necessary but NOT sufficient for a recommendation: see
   * twoBodyMeetsThreshold.
   */
  meetsThreshold: boolean;
  /** Burn ends before TCA and (if known) does not start in the past. */
  feasible: boolean;
  /** The burn would have to start before "now" (time remaining until TCA). */
  tooLate: boolean;
  /** Burn shorter than 10 % of the orbital period — effectively impulsive. */
  impulsiveOk: boolean;
  /** Shift of the closest-approach time caused by the burn (s, + = later). */
  tcaShiftSeconds: number;
  /**
   * The two-body re-solve of this burn (no linearisation), for the cells
   * the confirmation walk visited: CW-passing candidates in preference
   * order, up to and including the recommended one. null means the cell
   * was not visited, or the propagation failed (in that case
   * twoBodyMeetsThreshold is false).
   */
  twoBody: TwoBodyBurnCheck | null;
  /**
   * null = not re-solved. true = the two-body re-solve also clears the
   * decision rule (Pc < threshold and a miss wider than the baseline).
   * false = it does not, or the re-solve failed; the cell is never
   * recommended.
   */
  twoBodyMeetsThreshold: boolean | null;
}

export interface TradeBaseline {
  /** Straight-line closest-approach distance of the supplied TCA states (km). */
  missKm: number;
  pc: number;
  /**
   * Miss vector (secondary − target) at that straight-line closest
   * approach, in the target's RIC frame at TCA (km).
   */
  ricKm: RicVector;
  relativeSpeedKmS: number;
  /**
   * Time from the supplied states to the straight-line closest approach
   * (s). Non-zero when the screen's golden-section TCA (0.05 s bracket)
   * sits slightly off the true minimum — at 15 km/s that is up to
   * ~0.4 km of along-velocity offset in the screen's miss distance,
   * which this re-solve removes (Pc is unaffected either way: the
   * encounter-plane projection discards that component).
   */
  tcaOffsetSeconds: number;
}

export interface TradeSpace {
  leads: number[];
  dvs: number[];
  cells: TradeCell[];
  baseline: TradeBaseline;
  recommended: TradeCell | null;
  thresholdPc: number;
  /** baseline.pc ≥ thresholdPc — the decision rule calls for a maneuver. */
  maneuverRequired: boolean;
  /** Reference-orbit mean motion used by the CW model (rad/s). */
  meanMotionRadPerSec: number;
  /** Reference orbital period (s). */
  periodSeconds: number;
  /** Relative speed < 0.1 km/s: the short-encounter Pc is indicative only. */
  coOrbital: boolean;
  vehicleId: string;
  /** Time remaining until TCA used for the "too late" test (s), or null if unconstrained. */
  availableSeconds: number | null;
  /**
   * Two-body re-solve of `recommended`, which also clears the rule
   * there. null when nothing is recommended.
   */
  recommendedTwoBody: TwoBodyBurnCheck | null;
  /**
   * Number of CW-passing candidates that the two-body re-solve rejected
   * ahead of the recommendation (every candidate when nothing is
   * recommended).
   */
  twoBodyRejected: number;
}

/** Geometry for the two-body re-solves (sanitised by evaluateTradeGrid). */
export type TwoBodyEncounter = Pick<
  PlanAvoidanceInput,
  "targetState" | "secondaryState" | "sigmaRicKm" | "hardBodyRadiusM"
>;

/**
 * Time-independent half of planAvoidance (evaluateTradeGrid): every
 * cell's CW miss / Pc / RIC / propellant / burn time, plus the baseline
 * and the geometry for two-body re-solves. Feasibility here only means
 * "the burn ends before TCA" (tooLate is always false), and no
 * recommendation is chosen. finalizeTradeSpace applies the time
 * remaining and picks the two-body-confirmed recommendation. It is
 * cheap, so a UI clock tick never re-runs the 112 Pc integrals.
 */
export interface TradeGrid {
  leads: number[];
  dvs: number[];
  cells: TradeCell[];
  baseline: TradeBaseline;
  thresholdPc: number;
  maneuverRequired: boolean;
  meanMotionRadPerSec: number;
  periodSeconds: number;
  coOrbital: boolean;
  vehicleId: string;
  encounter: TwoBodyEncounter;
  /**
   * Memo of this grid's two-body re-solves, keyed by tradeCellKey. Each
   * result depends only on the grid's own geometry and vehicle.
   * finalizeTradeSpace only adds entries, so finalizing the same grid
   * again (the next clock tick) reuses every re-solve already done. The
   * memo saves work only: the output is identical with a cold memo.
   */
  twoBodyCache: Map<string, TwoBodyBurnCheck | null>;
}

export interface PlanAvoidanceInput {
  /** Target ECI state AT TCA (km, km/s). */
  targetState: StateVector;
  /** Secondary ECI state AT TCA (km, km/s). */
  secondaryState: StateVector;
  /** Assumed per-object 1-σ position uncertainty in RIC (km). */
  sigmaRicKm: [number, number, number];
  /** Combined hard-body radius (m). */
  hardBodyRadiusM: number;
  vehicle: VehiclePreset;
  /** Default STARLINK_PC_MANEUVER_THRESHOLD (1e-5). */
  thresholdPc?: number;
  /** Burn leads before TCA (s). */
  leads?: number[];
  /** Δv magnitudes (m/s). */
  dvsMps?: number[];
  /**
   * Seconds from now until TCA. When given (> 0), burns that would
   * have to start before now are infeasible. Omit for an
   * unconstrained (illustrative) trade space.
   */
  availableSeconds?: number;
}

export interface CwComparison {
  leadSeconds: number;
  dv: RicDeltaV;
  /** CW prediction (km, RIC of the unperturbed path at τ). */
  cw: RicVector;
  /** Two-body truth (km, same frame). */
  truth: RicVector;
  /** |cw − truth| / |truth| (fraction). */
  relativeError: number;
  /**
   * Two-body truth in the CURVILINEAR RIC of the unperturbed path at τ
   * (km): radial = difference of radii; in-track and cross-track = arc
   * lengths. This removes the y²/2r curvature artefact of `truth`.
   */
  truthCurvilinear: RicVector;
  /**
   * Encounter-plane error (fraction), or null when no encounter velocity
   * was supplied. It is |P(cw − truthCurvilinear)| divided by the larger
   * of |P(truthCurvilinear)| and the CW response scale |Δv|/n, where P
   * projects onto the plane ⟂ the relative velocity at TCA. The floor
   * keeps a lead where the burn barely moves the encounter plane from
   * producing a meaningless ratio.
   */
  encounterPlaneError: number | null;
}

/** Live linearisation check for one screened geometry (checkLinearisation). */
export interface LinearisationCheck {
  /** Osculating eccentricity of the target at TCA (CW assumes a circular reference). */
  eccentricity: number;
  /**
   * Max encounter-plane error over the check burns (fraction): the part
   * of the CW error that moves the miss and Pc (see
   * CwComparison.encounterPlaneError).
   */
  maxEncounterPlaneError: number;
  /** Max 3-D rectilinear error, the value verifyCwAgainstTwoBody returns (fraction). */
  maxError3d: number;
  /** Number of impulsive check burns. */
  cases: number;
  /** Δv of each check burn (m/s). */
  referenceDvMps: number;
  /**
   * maxEncounterPlaneError ≤ CW_VALID_MAX_ERROR AND eccentricity ≤
   * CW_VALID_MAX_ECCENTRICITY. When false the CW heat map is indicative
   * only. The recommendation is two-body-confirmed either way.
   */
  valid: boolean;
}

export interface TwoBodyBurnCheck {
  /** True closest-approach distance (km) with both objects on two-body arcs. */
  missKm: number;
  /** Pc at that true closest approach (same covariance + HBR). */
  pc: number;
  /** Two-body target displacement at the nominal TCA, target RIC (km). */
  ricKm: RicVector;
  /** True TCA shift relative to the nominal TCA (s). */
  tcaShiftSeconds: number;
}

export interface PcSensitivityPoint {
  /** Multiplier applied to every 1-σ value (the covariance scales by scale²). */
  scale: number;
  pc: number;
}

export interface PcDilution {
  /** Pc at the nominal (scale 1) covariance. */
  nominalPc: number;
  /** σ scale at which Pc peaks (searched on a log grid 0.05×-50×). */
  peakScale: number;
  peakPc: number;
  /**
   * True when the nominal covariance sits in the probability-dilution
   * region: Pc FALLS as the covariance grows (the peak lies below 1×),
   * so a low Pc there reflects uncertainty, not safety — better
   * tracking (a smaller covariance) could RAISE it.
   */
  diluted: boolean;
}

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/** Standard gravity for Tsiolkovsky (m/s²). */
export const G0_MPS2 = 9.80665;

/** Below this relative speed the short-encounter Pc is indicative only (km/s). */
export const CO_ORBITAL_SPEED_KM_S = 0.1;

/** Burns shorter than this fraction of the period count as impulsive. */
export const IMPULSIVE_PERIOD_FRACTION = 0.1;

/** Sub-impulses used to model a finite burn by CW superposition. */
export const FINITE_BURN_SUBSTEPS = 16;

export const DEFAULT_LEADS_SECONDS: readonly number[] = [
  12 * 3600,
  8 * 3600,
  6 * 3600,
  4 * 3600,
  3 * 3600,
  2 * 3600,
  1 * 3600,
  30 * 60,
];

export const DEFAULT_DVS_MPS: readonly number[] = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0];

/** Default σ multipliers for the Pc sensitivity curve. */
export const DEFAULT_SENSITIVITY_SCALES: readonly number[] = [0.25, 0.5, 1, 2, 4, 8];

/** Reference Δv (m/s) for the live linearisation check when nothing is recommended. */
export const CW_CHECK_REFERENCE_DV_MPS = 0.05;

/** The linearisation counts as "verified" only up to this encounter-plane error (fraction). */
export const CW_VALID_MAX_ERROR = 0.02;

/**
 * ...and only for a near-circular target (CW assumes a circular
 * reference orbit; the radial error grows like e × in-track drift).
 */
export const CW_VALID_MAX_ECCENTRICITY = 0.005;

/**
 * Vehicle presets. PUBLIC ESTIMATES ONLY — SpaceX does not publish
 * Starlink thruster or mass figures in this form; treat every
 * number as an assumption (the UI says so).
 */
export const VEHICLE_PRESETS: VehiclePreset[] = [
  {
    id: "starlink-v2mini",
    label: "Starlink V2 Mini-class",
    wetMassKg: 800,
    ispSeconds: 2500,
    thrustNewtons: 0.17,
    note: "argon Hall-effect thruster; public estimates, treat as assumptions",
  },
  {
    id: "starlink-v1.5",
    label: "Starlink V1.5-class",
    wetMassKg: 306,
    ispSeconds: 1500,
    thrustNewtons: 0.08,
    note: "krypton Hall-effect thruster; public estimates",
  },
  {
    id: "generic-hydrazine",
    label: "Generic 1,000 kg hydrazine bus",
    wetMassKg: 1000,
    ispSeconds: 220,
    thrustNewtons: 22,
    note: "matches the Phase 2 maneuver-plan assumption",
  },
];

/* ------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------ */

function isFiniteVec(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    typeof v[2] === "number" &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  );
}

/**
 * True when `s` is a usable Earth-orbit ECI state: finite 3-vectors,
 * geocentric radius above 6,000 km, non-zero speed.
 */
export function isUsableState(s: unknown): s is StateVector {
  if (!s || typeof s !== "object") return false;
  const o = s as { position?: unknown; velocity?: unknown };
  if (!isFiniteVec(o.position) || !isFiniteVec(o.velocity)) return false;
  return vNorm(o.position) > 6000 && vNorm(o.velocity) > 0;
}

function ricToEci(v: RicVector, frame: RicFrame): Vec3 {
  return vAdd(
    vAdd(vScale(frame.radial, v.radialKm), vScale(frame.inTrack, v.inTrackKm)),
    vScale(frame.crossTrack, v.crossTrackKm)
  );
}

function ricNorm(v: RicVector): number {
  return Math.sqrt(v.radialKm ** 2 + v.inTrackKm ** 2 + v.crossTrackKm ** 2);
}

function ricSub(a: RicVector, b: RicVector): RicVector {
  return {
    radialKm: a.radialKm - b.radialKm,
    inTrackKm: a.inTrackKm - b.inTrackKm,
    crossTrackKm: a.crossTrackKm - b.crossTrackKm,
  };
}

/** Component of `v` in the plane ⟂ `unitNormal` (both RIC); `v` itself when the normal is null. */
function ricProjectOntoPlane(v: RicVector, unitNormal: RicVector | null): RicVector {
  if (!unitNormal) return v;
  const d =
    v.radialKm * unitNormal.radialKm +
    v.inTrackKm * unitNormal.inTrackKm +
    v.crossTrackKm * unitNormal.crossTrackKm;
  return {
    radialKm: v.radialKm - d * unitNormal.radialKm,
    inTrackKm: v.inTrackKm - d * unitNormal.inTrackKm,
    crossTrackKm: v.crossTrackKm - d * unitNormal.crossTrackKm,
  };
}

/**
 * `position` relative to `reference`, in the reference's CURVILINEAR
 * RIC (km). Radial is the difference of radii. In-track is the arc
 * length in the reference orbit plane. Cross-track is the arc length
 * out of that plane. A long in-track drift therefore shows no y²/2r
 * radial artefact.
 */
function curvilinearRic(position: Vec3, reference: StateVector): RicVector {
  const frame = ricFrame(reference.position, reference.velocity);
  const rRef = vNorm(reference.position);
  const r = vNorm(position);
  const u = vScale(position, 1 / r);
  const sinC = Math.max(-1, Math.min(1, vDot(u, frame.crossTrack)));
  return {
    radialKm: r - rRef,
    inTrackKm: rRef * Math.atan2(vDot(u, frame.inTrack), vDot(u, frame.radial)),
    crossTrackKm: rRef * Math.asin(sinC),
  };
}

/** Stable key of a trade cell (lead|Δv|direction): grid lookups and the two-body memo. */
export function tradeCellKey(c: Pick<TradeCell, "leadSeconds" | "dvMps" | "direction">): string {
  return `${c.leadSeconds}|${c.dvMps}|${c.direction}`;
}

/** In-track Δv vector (m/s) for a direction. */
export function inTrackDeltaV(dvMps: number, direction: BurnDirection): RicDeltaV {
  return {
    radialMps: 0,
    inTrackMps: direction === "PROGRADE" ? dvMps : -dvMps,
    crossTrackMps: 0,
  };
}

function cleanList(values: readonly number[] | undefined, fallback: readonly number[]): number[] {
  const src = Array.isArray(values) && values.length > 0 ? values : fallback;
  const out = src.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0);
  return Array.from(new Set(out));
}

function sanitizeSigma(s: [number, number, number]): Vec3 {
  const fallback: Vec3 = [0.3, 1.0, 0.3];
  if (!Array.isArray(s) || s.length !== 3) return fallback;
  return [0, 1, 2].map((k) => {
    const v = s[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback[k];
  }) as Vec3;
}

function sanitizeHbrKm(hardBodyRadiusM: number): number {
  return (Number.isFinite(hardBodyRadiusM) && hardBodyRadiusM > 0 ? hardBodyRadiusM : 20) / 1000;
}

/* ------------------------------------------------------------
   Reference orbit
   ------------------------------------------------------------ */

/**
 * Mean motion (rad/s) of the osculating orbit through `state`, from
 * the vis-viva semi-major axis a = 1 / (2/r − v²/μ). Falls back to
 * the circular value at the current radius for an unbound state.
 */
export function referenceMeanMotionRadPerSec(state: StateVector): number {
  const r = vNorm(state.position);
  const v = vNorm(state.velocity);
  const inv = 2 / r - (v * v) / MU_EARTH_KM3_S2;
  if (Number.isFinite(inv) && inv > 0) {
    return meanMotionRadPerSec(1 / inv);
  }
  return meanMotionRadPerSec(r);
}

/**
 * Osculating eccentricity of the two-body orbit through `state`:
 * |((v² − μ/r)·r − (r·v)·v)| / μ. NaN for an unusable state.
 */
export function osculatingEccentricity(state: StateVector): number {
  if (!isUsableState(state)) return Number.NaN;
  const r = vNorm(state.position);
  const v2 = vDot(state.velocity, state.velocity);
  const rv = vDot(state.position, state.velocity);
  const eVec = vSub(
    vScale(state.position, v2 - MU_EARTH_KM3_S2 / r),
    vScale(state.velocity, rv)
  );
  const e = vNorm(eVec) / MU_EARTH_KM3_S2;
  return Number.isFinite(e) ? e : Number.NaN;
}

/* ------------------------------------------------------------
   Clohessy-Wiltshire displacement
   ------------------------------------------------------------ */

/**
 * Hill / Clohessy-Wiltshire displacement AT TCA of a vehicle that
 * applied impulse `dv` (m/s, RIC at burn time) `leadSeconds` before
 * TCA, relative to its unperturbed path, expressed in that path's
 * RIC frame at TCA (km). See the file header for the equations and
 * their numerical verification against two-body truth.
 */
export function cwDisplacement(
  dv: RicDeltaV,
  leadSeconds: number,
  meanMotion: number
): RicVector {
  const n = meanMotion;
  const t = leadSeconds;
  if (!(n > 0) || !Number.isFinite(n) || !Number.isFinite(t)) {
    return { radialKm: 0, inTrackKm: 0, crossTrackKm: 0 };
  }
  const dvr = (Number.isFinite(dv.radialMps) ? dv.radialMps : 0) / 1000;
  const dvi = (Number.isFinite(dv.inTrackMps) ? dv.inTrackMps : 0) / 1000;
  const dvc = (Number.isFinite(dv.crossTrackMps) ? dv.crossTrackMps : 0) / 1000;
  const s = Math.sin(n * t);
  const c = Math.cos(n * t);
  return {
    radialKm: (dvr / n) * s + ((2 * dvi) / n) * (1 - c),
    inTrackKm: ((2 * dvr) / n) * (c - 1) + dvi * ((4 * s) / n - 3 * t),
    crossTrackKm: (dvc / n) * s,
  };
}

/**
 * Finite constant-thrust burn of total `dv`, duration `burnSeconds`,
 * CENTRED `leadSeconds` before TCA: superposition of
 * FINITE_BURN_SUBSTEPS equal sub-impulses (exact within linear CW
 * theory). Reduces to cwDisplacement for a negligible burn duration.
 */
export function cwFiniteBurnDisplacement(
  dv: RicDeltaV,
  leadSeconds: number,
  burnSeconds: number,
  meanMotion: number
): RicVector {
  const period = meanMotion > 0 ? (2 * Math.PI) / meanMotion : Number.POSITIVE_INFINITY;
  if (!(burnSeconds > 0) || !Number.isFinite(burnSeconds) || burnSeconds < 1e-3 * period) {
    return cwDisplacement(dv, leadSeconds, meanMotion);
  }
  const N = FINITE_BURN_SUBSTEPS;
  const sub: RicDeltaV = {
    radialMps: dv.radialMps / N,
    inTrackMps: dv.inTrackMps / N,
    crossTrackMps: dv.crossTrackMps / N,
  };
  const out: RicVector = { radialKm: 0, inTrackKm: 0, crossTrackKm: 0 };
  for (let k = 0; k < N; k++) {
    const tau = leadSeconds + burnSeconds / 2 - ((k + 0.5) * burnSeconds) / N;
    const d = cwDisplacement(sub, tau, meanMotion);
    out.radialKm += d.radialKm;
    out.inTrackKm += d.inTrackKm;
    out.crossTrackKm += d.crossTrackKm;
  }
  return out;
}

/**
 * Compare cwDisplacement with Keplerian two-body truth for ONE
 * impulsive burn applied to `burnState` (the vehicle state AT BURN
 * TIME): the perturbed and unperturbed states are both propagated by
 * `leadSeconds`, and their position difference is expressed in the
 * unperturbed RIC frame at the end. When given, `encounterVelocityEci`
 * (relative velocity secondary − target at TCA) also yields the
 * encounter-plane error. Returns null if propagation fails.
 */
export function cwVersusTwoBody(
  burnState: StateVector,
  dv: RicDeltaV,
  leadSeconds: number,
  meanMotion?: number,
  encounterVelocityEci?: Vec3
): CwComparison | null {
  if (!isUsableState(burnState) || !(leadSeconds > 0) || !Number.isFinite(leadSeconds)) return null;
  const frame0 = ricFrame(burnState.position, burnState.velocity);
  const dvKmS = ricToEci(
    {
      radialKm: dv.radialMps / 1000,
      inTrackKm: dv.inTrackMps / 1000,
      crossTrackKm: dv.crossTrackMps / 1000,
    },
    frame0
  );
  const perturbed0: StateVector = {
    position: [burnState.position[0], burnState.position[1], burnState.position[2]],
    velocity: vAdd(burnState.velocity, dvKmS),
  };
  const ref = twoBodyPropagate(burnState, leadSeconds);
  const pert = twoBodyPropagate(perturbed0, leadSeconds);
  if (!ref || !pert) return null;
  const frameT = ricFrame(ref.position, ref.velocity);
  const truth = toRic(vSub(pert.position, ref.position), frameT);
  const n =
    meanMotion !== undefined && meanMotion > 0 && Number.isFinite(meanMotion)
      ? meanMotion
      : referenceMeanMotionRadPerSec(burnState);
  const cw = cwDisplacement(dv, leadSeconds, n);
  const truthNorm = ricNorm(truth);
  const relativeError = truthNorm > 0 ? ricNorm(ricSub(cw, truth)) / truthNorm : 0;
  if (!Number.isFinite(relativeError)) return null;

  const truthCurvilinear = curvilinearRic(pert.position, ref);
  let encounterPlaneError: number | null = null;
  if (encounterVelocityEci !== undefined && isFiniteVec(encounterVelocityEci)) {
    // Encounter plane ⟂ relative velocity, in the RIC frame at TCA. With
    // no meaningful relative velocity (co-orbital), use the full 3-D error.
    const wRic = toRic(encounterVelocityEci, frameT);
    const wNorm = ricNorm(wRic);
    const normal: RicVector | null =
      wNorm > 1e-9
        ? {
            radialKm: wRic.radialKm / wNorm,
            inTrackKm: wRic.inTrackKm / wNorm,
            crossTrackKm: wRic.crossTrackKm / wNorm,
          }
        : null;
    const dvKmSNorm =
      Math.sqrt(dv.radialMps ** 2 + dv.inTrackMps ** 2 + dv.crossTrackMps ** 2) / 1000;
    const errKm = ricNorm(ricProjectOntoPlane(ricSub(cw, truthCurvilinear), normal));
    const scaleKm = Math.max(ricNorm(ricProjectOntoPlane(truthCurvilinear, normal)), dvKmSNorm / n);
    encounterPlaneError = scaleKm > 0 ? errKm / scaleKm : 0;
    if (!Number.isFinite(encounterPlaneError)) return null;
  }
  return { leadSeconds, dv, cw, truth, relativeError, truthCurvilinear, encounterPlaneError };
}

/**
 * Per-case detail behind verifyCwAgainstTwoBody / checkLinearisation
 * (same inputs; `encounterVelocityEci` enables the encounter-plane error).
 */
export function cwTwoBodyComparisons(
  stateAtTca: StateVector,
  cases?: Array<{ dv: RicDeltaV; leadSeconds: number }>,
  referenceDvMps: number = CW_CHECK_REFERENCE_DV_MPS,
  encounterVelocityEci?: Vec3
): CwComparison[] | null {
  if (!isUsableState(stateAtTca)) return null;
  const dvRef =
    Number.isFinite(referenceDvMps) && referenceDvMps > 0 ? referenceDvMps : CW_CHECK_REFERENCE_DV_MPS;
  const list =
    cases && cases.length > 0
      ? cases
      : DEFAULT_LEADS_SECONDS.flatMap((leadSeconds) => [
          { leadSeconds, dv: inTrackDeltaV(dvRef, "PROGRADE") },
          { leadSeconds, dv: inTrackDeltaV(dvRef, "RETROGRADE") },
        ]);
  const n = referenceMeanMotionRadPerSec(stateAtTca);
  const out: CwComparison[] = [];
  for (const c of list) {
    if (!(c.leadSeconds > 0) || !Number.isFinite(c.leadSeconds)) continue;
    const burnState = twoBodyPropagate(stateAtTca, -c.leadSeconds);
    if (!burnState) return null;
    const cmp = cwVersusTwoBody(burnState, c.dv, c.leadSeconds, n, encounterVelocityEci);
    if (!cmp) return null;
    out.push(cmp);
  }
  return out;
}

/**
 * Live linearisation check for a screened geometry. `stateAtTca` is
 * the target state AT TCA; for each case it is propagated BACK by the
 * lead (two-body) to get the burn-time state, the impulse is applied,
 * and the CW displacement is compared with two-body truth at TCA.
 *
 * Default cases: every lead in DEFAULT_LEADS_SECONDS, prograde AND
 * retrograde, at `referenceDvMps` (default 5 cm/s).
 *
 * Returns the MAX 3-D relative error |cw − truth| / |truth| (fraction,
 * e.g. 0.004 = 0.4 %) or null when any propagation fails. Note: the
 * in-track drift dominates that norm. To decide whether the trade
 * space can be trusted for an encounter, use checkLinearisation, which
 * measures the encounter-plane error and the eccentricity.
 */
export function verifyCwAgainstTwoBody(
  stateAtTca: StateVector,
  cases?: Array<{ dv: RicDeltaV; leadSeconds: number }>,
  referenceDvMps: number = CW_CHECK_REFERENCE_DV_MPS
): number | null {
  const results = cwTwoBodyComparisons(stateAtTca, cases, referenceDvMps);
  if (!results || results.length === 0) return null;
  let max = 0;
  for (const r of results) max = Math.max(max, r.relativeError);
  return max;
}

/**
 * Decision-relevant linearisation check for one screened encounter.
 * The check burns are the same as verifyCwAgainstTwoBody's: every lead
 * in DEFAULT_LEADS_SECONDS, prograde AND retrograde, at
 * `referenceDvMps`. The error is measured in curvilinear RIC and
 * projected onto the encounter plane of THIS conjunction. That is the
 * part of the displacement that moves the miss and Pc. Head-on, it is
 * the radial error, which a 3-D norm hides behind tens of km of
 * in-track drift. `valid` also requires a near-circular target.
 * Returns null on unusable states or a propagation failure.
 */
export function checkLinearisation(
  targetState: StateVector,
  secondaryState: StateVector,
  referenceDvMps: number = CW_CHECK_REFERENCE_DV_MPS
): LinearisationCheck | null {
  if (!isUsableState(targetState) || !isUsableState(secondaryState)) return null;
  const dvRef =
    Number.isFinite(referenceDvMps) && referenceDvMps > 0 ? referenceDvMps : CW_CHECK_REFERENCE_DV_MPS;
  const w = vSub(secondaryState.velocity, targetState.velocity);
  const results = cwTwoBodyComparisons(targetState, undefined, dvRef, w);
  if (!results || results.length === 0) return null;
  let maxPlane = 0;
  let max3d = 0;
  for (const r of results) {
    max3d = Math.max(max3d, r.relativeError);
    maxPlane = Math.max(maxPlane, r.encounterPlaneError ?? r.relativeError);
  }
  const eccentricity = osculatingEccentricity(targetState);
  return {
    eccentricity,
    maxEncounterPlaneError: maxPlane,
    maxError3d: max3d,
    cases: results.length,
    referenceDvMps: dvRef,
    valid:
      maxPlane <= CW_VALID_MAX_ERROR &&
      Number.isFinite(eccentricity) &&
      eccentricity <= CW_VALID_MAX_ECCENTRICITY,
  };
}

/* ------------------------------------------------------------
   Propellant + burn time
   ------------------------------------------------------------ */

/** Tsiolkovsky: propellant (kg) for Δv (m/s) from wet mass and Isp. */
export function propellantKg(dvMps: number, wetMassKg: number, ispSeconds: number): number {
  if (!(dvMps >= 0) || !(wetMassKg > 0) || !(ispSeconds > 0)) return 0;
  const ve = ispSeconds * G0_MPS2;
  const kg = wetMassKg * (1 - Math.exp(-dvMps / ve));
  return Number.isFinite(kg) ? kg : 0;
}

/**
 * Constant-thrust burn duration (s) ≈ m·Δv / F. Mass loss during a
 * cm/s-class burn is < 0.01 %, so the wet mass is used throughout.
 * +Infinity for a zero / invalid thrust.
 */
export function burnDurationSeconds(dvMps: number, wetMassKg: number, thrustNewtons: number): number {
  if (!(dvMps >= 0) || !(wetMassKg > 0) || !(thrustNewtons > 0)) return Number.POSITIVE_INFINITY;
  const s = (wetMassKg * dvMps) / thrustNewtons;
  return Number.isFinite(s) ? s : Number.POSITIVE_INFINITY;
}

/* ------------------------------------------------------------
   Encounter evaluation
   ------------------------------------------------------------ */

interface EncounterEval {
  missKm: number;
  pc: number;
  tcaShiftSeconds: number;
}

/**
 * Closest approach under straight-line relative motion near TCA,
 * plus Pc under the stated covariance. With rel = r_s − r_t and
 * w = v_s − v_t, the closest point is at Δt = −(rel·w)/|w|² and the
 * miss is |rel + w·Δt| (the encounter-plane projection the Pc
 * integral uses too).
 */
function evaluateEncounter(
  targetPos: Vec3,
  targetVel: Vec3,
  secondary: StateVector,
  sigma: Vec3,
  hardBodyRadiusKm: number
): EncounterEval {
  const rel = vSub(secondary.position, targetPos);
  const w = vSub(secondary.velocity, targetVel);
  const w2 = vDot(w, w);
  let dt = 0;
  let missKm = vNorm(rel);
  if (w2 > 1e-18) {
    dt = -vDot(rel, w) / w2;
    missKm = vNorm(vAdd(rel, vScale(w, dt)));
  }
  const pc = probabilityOfCollision({
    primary: { position: targetPos, velocity: targetVel, sigmaRicKm: sigma },
    secondary: {
      position: secondary.position,
      velocity: secondary.velocity,
      sigmaRicKm: sigma,
    },
    hardBodyRadiusKm,
  });
  return { missKm, pc: Number.isFinite(pc) ? pc : 0, tcaShiftSeconds: dt };
}

/* ------------------------------------------------------------
   Trade space
   ------------------------------------------------------------ */

/**
 * Evaluate the burn trade space for one screened close approach, then
 * apply the time remaining and choose the two-body-confirmed
 * recommendation. This is evaluateTradeGrid followed by
 * finalizeTradeSpace. Throws on unusable state vectors (callers show
 * "rerun the screen"). Cost: ~112 cells × one Pc integral ≈ 30-40 ms in
 * Node, plus ~1 ms for each candidate the confirmation walk re-solves on
 * two-body arcs (usually one to a few).
 */
export function planAvoidance(input: PlanAvoidanceInput): TradeSpace {
  return finalizeTradeSpace(evaluateTradeGrid(input), input.availableSeconds);
}

function sanitizeAvailableSeconds(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Time-independent half of planAvoidance: every cell's CW displacement,
 * miss, Pc, propellant and burn time, plus the baseline. This is the
 * expensive part. A UI memoises it per event, vehicle and covariance,
 * and calls finalizeTradeSpace on every clock tick.
 * `input.availableSeconds` is ignored here. Throws on unusable states.
 */
export function evaluateTradeGrid(input: PlanAvoidanceInput): TradeGrid {
  const { targetState, secondaryState, vehicle } = input;
  if (!isUsableState(targetState) || !isUsableState(secondaryState)) {
    throw new Error("Avoidance planner needs finite ECI state vectors at TCA");
  }
  const sigma = sanitizeSigma(input.sigmaRicKm);
  const hbrKm = sanitizeHbrKm(input.hardBodyRadiusM);
  const thresholdPc =
    typeof input.thresholdPc === "number" && Number.isFinite(input.thresholdPc) && input.thresholdPc > 0
      ? input.thresholdPc
      : STARLINK_PC_MANEUVER_THRESHOLD;
  const leads = cleanList(input.leads, DEFAULT_LEADS_SECONDS).sort((a, b) => b - a);
  const dvs = cleanList(input.dvsMps, DEFAULT_DVS_MPS).sort((a, b) => a - b);

  const n = referenceMeanMotionRadPerSec(targetState);
  const periodSeconds = (2 * Math.PI) / n;
  const frame = ricFrame(targetState.position, targetState.velocity);

  // ---- Baseline ----
  const base = evaluateEncounter(
    targetState.position,
    targetState.velocity,
    secondaryState,
    sigma,
    hbrKm
  );
  const relVel = vSub(secondaryState.velocity, targetState.velocity);
  const missVector = vAdd(
    vSub(secondaryState.position, targetState.position),
    vScale(relVel, base.tcaShiftSeconds)
  );
  const baseline: TradeBaseline = {
    missKm: base.missKm,
    pc: base.pc,
    ricKm: toRic(missVector, frame),
    relativeSpeedKmS: vNorm(relVel),
    tcaOffsetSeconds: base.tcaShiftSeconds,
  };

  // ---- Cells ----
  const cells: TradeCell[] = [];
  const directions: BurnDirection[] = ["PROGRADE", "RETROGRADE"];
  for (const leadSeconds of leads) {
    for (const dvMps of dvs) {
      const prop = propellantKg(dvMps, vehicle.wetMassKg, vehicle.ispSeconds);
      const burn = burnDurationSeconds(dvMps, vehicle.wetMassKg, vehicle.thrustNewtons);
      const endsBeforeTca = Number.isFinite(burn) && burn / 2 < leadSeconds;
      const impulsiveOk = Number.isFinite(burn) && burn <= IMPULSIVE_PERIOD_FRACTION * periodSeconds;
      for (const direction of directions) {
        const d = cwFiniteBurnDisplacement(
          inTrackDeltaV(dvMps, direction),
          leadSeconds,
          Number.isFinite(burn) ? burn : 0,
          n
        );
        const newPos = vAdd(targetState.position, ricToEci(d, frame));
        const e = evaluateEncounter(newPos, targetState.velocity, secondaryState, sigma, hbrKm);
        cells.push({
          leadSeconds,
          dvMps,
          direction,
          missKm: e.missKm,
          pc: e.pc,
          ricKm: d,
          propellantKg: prop,
          burnSeconds: burn,
          meetsThreshold: endsBeforeTca && e.pc < thresholdPc && e.missKm > baseline.missKm,
          feasible: endsBeforeTca,
          tooLate: false,
          impulsiveOk,
          tcaShiftSeconds: e.tcaShiftSeconds,
          twoBody: null,
          twoBodyMeetsThreshold: null,
        });
      }
    }
  }

  return {
    leads,
    dvs,
    cells,
    baseline,
    thresholdPc,
    maneuverRequired: baseline.pc >= thresholdPc,
    meanMotionRadPerSec: n,
    periodSeconds,
    coOrbital: baseline.relativeSpeedKmS < CO_ORBITAL_SPEED_KM_S,
    vehicleId: vehicle.id,
    encounter: {
      targetState,
      secondaryState,
      sigmaRicKm: sigma,
      hardBodyRadiusM: hbrKm * 1000,
    },
    twoBodyCache: new Map(),
  };
}

/**
 * Time-dependent half of planAvoidance. It is cheap: no CW or Pc
 * re-evaluation.
 * 1. Feasibility against the time remaining. A burn that would have to
 *    START before now (lead + burn/2 > availableSeconds) is too late.
 *    A null or non-positive value leaves the grid unconstrained.
 * 2. Recommendation. Walk the cells that clear the rule under CW, in
 *    preference order (smallest Δv, then longest lead, then lowest Pc).
 *    Re-solve each one on two-body arcs (evaluateBurnTwoBody), using
 *    grid.twoBodyCache, and recommend the FIRST that also clears the
 *    rule there. CW-only passes are flagged and skipped. If none
 *    confirms, nothing is recommended: escalate rather than trust a
 *    linearised pass.
 * The grid's own cells are never modified; a fresh cell array is returned.
 */
export function finalizeTradeSpace(grid: TradeGrid, availableSeconds?: number | null): TradeSpace {
  const available = sanitizeAvailableSeconds(availableSeconds);
  const { thresholdPc, baseline } = grid;
  const clearsOnTwoBody = (tb: TwoBodyBurnCheck | null): boolean =>
    tb !== null && tb.pc < thresholdPc && tb.missKm > baseline.missKm;

  const cells: TradeCell[] = grid.cells.map((c) => {
    const burnFinite = Number.isFinite(c.burnSeconds);
    const endsBeforeTca = burnFinite && c.burnSeconds / 2 < c.leadSeconds;
    const tooLate = available !== null && c.leadSeconds + (burnFinite ? c.burnSeconds / 2 : 0) > available;
    const feasible = endsBeforeTca && !tooLate;
    return {
      ...c,
      feasible,
      tooLate,
      meetsThreshold: feasible && c.pc < thresholdPc && c.missKm > baseline.missKm,
      // Filled below for the cells THIS walk visits. The memo only saves
      // work; it never changes the output, so the result does not depend
      // on earlier calls.
      twoBody: null,
      twoBodyMeetsThreshold: null,
    };
  });

  const candidates = cells
    .filter((c) => c.meetsThreshold)
    .sort((a, b) => a.dvMps - b.dvMps || b.leadSeconds - a.leadSeconds || a.pc - b.pc);
  let recommended: TradeCell | null = null;
  let twoBodyRejected = 0;
  for (const c of candidates) {
    const key = tradeCellKey(c);
    let tb = grid.twoBodyCache.get(key);
    if (tb === undefined) {
      tb = evaluateBurnTwoBody(grid.encounter, c.leadSeconds, c.dvMps, c.direction, c.burnSeconds);
      grid.twoBodyCache.set(key, tb);
    }
    // `c` is this call's own copy — safe to fill in.
    c.twoBody = tb;
    c.twoBodyMeetsThreshold = clearsOnTwoBody(tb);
    if (c.twoBodyMeetsThreshold) {
      recommended = c;
      break;
    }
    twoBodyRejected++;
  }

  return {
    leads: grid.leads,
    dvs: grid.dvs,
    cells,
    baseline,
    recommended,
    thresholdPc,
    maneuverRequired: grid.maneuverRequired,
    meanMotionRadPerSec: grid.meanMotionRadPerSec,
    periodSeconds: grid.periodSeconds,
    coOrbital: grid.coOrbital,
    vehicleId: grid.vehicleId,
    availableSeconds: available,
    recommendedTwoBody: recommended?.twoBody ?? null,
    twoBodyRejected,
  };
}

/**
 * Two-body TRUTH for one trade cell, with no linearisation anywhere:
 * the target is back-propagated from TCA to burn start, the burn is
 * applied as FINITE_BURN_SUBSTEPS sub-impulses (each along the local
 * in-track axis, two-body coasts in between; one impulse when
 * burnSeconds = 0), and BOTH objects are then propagated on Keplerian
 * arcs around the predicted TCA; the true minimum separation is found
 * by a coarse scan + golden-section search (to 1 ms). Pc is evaluated
 * at that true closest approach under the same covariance and HBR.
 *
 * Comparing the CW miss with this — rather than plugging the
 * Cartesian two-body displacement into the straight-line encounter —
 * matters for long leads: the target slides kilometres along a CURVED
 * arc, and so does the secondary, so the curvature terms cancel in
 * the true miss but would not in a straight-line evaluation.
 * null when a propagation fails.
 */
export function evaluateBurnTwoBody(
  input: Pick<PlanAvoidanceInput, "targetState" | "secondaryState" | "sigmaRicKm" | "hardBodyRadiusM">,
  leadSeconds: number,
  dvMps: number,
  direction: BurnDirection,
  burnSeconds: number = 0
): TwoBodyBurnCheck | null {
  const { targetState, secondaryState } = input;
  if (!isUsableState(targetState) || !isUsableState(secondaryState)) return null;
  if (!(leadSeconds > 0) || !(dvMps > 0) || !Number.isFinite(leadSeconds) || !Number.isFinite(dvMps)) {
    return null;
  }
  const burn = Number.isFinite(burnSeconds) && burnSeconds > 0 ? burnSeconds : 0;
  if (burn / 2 >= leadSeconds) return null; // burn would not end before TCA
  const sigma = sanitizeSigma(input.sigmaRicKm);
  const hbrKm = sanitizeHbrKm(input.hardBodyRadiusM);
  const n = referenceMeanMotionRadPerSec(targetState);
  const period = (2 * Math.PI) / n;
  const sign = direction === "PROGRADE" ? 1 : -1;

  // ---- Burn on two-body arcs (times relative to TCA, seconds) ----
  const N = burn > 0 ? FINITE_BURN_SUBSTEPS : 1;
  const subDvKmS = (sign * dvMps) / 1000 / N;
  const startTime = -leadSeconds - burn / 2;
  const start = twoBodyPropagate(targetState, startTime);
  if (!start) return null;
  let state: StateVector = start;
  let time = startTime;
  for (let k = 0; k < N; k++) {
    const tk = burn > 0 ? startTime + ((k + 0.5) * burn) / N : -leadSeconds;
    const coast = twoBodyPropagate(state, tk - time);
    if (!coast) return null;
    const f = ricFrame(coast.position, coast.velocity);
    state = { position: coast.position, velocity: vAdd(coast.velocity, vScale(f.inTrack, subDvKmS)) };
    time = tk;
  }
  const perturbedAtTca = twoBodyPropagate(state, -time);
  const referenceAtTca = twoBodyPropagate(start, -startTime);
  if (!perturbedAtTca || !referenceAtTca) return null;
  const frameT = ricFrame(referenceAtTca.position, referenceAtTca.velocity);
  const ricKm = toRic(vSub(perturbedAtTca.position, referenceAtTca.position), frameT);

  // ---- True closest approach around the linear prediction ----
  const linearPos = vAdd(targetState.position, ricToEci(ricKm, ricFrame(targetState.position, targetState.velocity)));
  const predicted = evaluateEncounter(linearPos, targetState.velocity, secondaryState, sigma, hbrKm);
  const halfWindow = Math.min(period / 4, Math.max(30, 0.5 * Math.abs(predicted.tcaShiftSeconds) + 30));
  const center = Math.max(-period / 4, Math.min(period / 4, predicted.tcaShiftSeconds));

  const sep = (dt: number): { d: number; t: StateVector; s: StateVector } | null => {
    const t = twoBodyPropagate(perturbedAtTca, dt);
    const s = twoBodyPropagate(secondaryState, dt);
    if (!t || !s) return null;
    return { d: vNorm(vSub(s.position, t.position)), t, s };
  };
  const dist = (dt: number): number => sep(dt)?.d ?? Number.POSITIVE_INFINITY;

  const STEPS = 40;
  const step = (2 * halfWindow) / STEPS;
  let bestK = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let k = 0; k <= STEPS; k++) {
    const dk = dist(center - halfWindow + k * step);
    if (dk < bestD) {
      bestD = dk;
      bestK = k;
    }
  }
  if (bestK < 0) return null;
  let a = center - halfWindow + Math.max(0, bestK - 1) * step;
  let b = center - halfWindow + Math.min(STEPS, bestK + 1) * step;
  const gr = (Math.sqrt(5) - 1) / 2;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  let fc = dist(c);
  let fd = dist(d);
  for (let guard = 0; b - a > 1e-3 && guard < 200; guard++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - gr * (b - a);
      fc = dist(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + gr * (b - a);
      fd = dist(d);
    }
  }
  const tBest = (a + b) / 2;
  const at = sep(tBest);
  if (!at) return null;
  const pc = probabilityOfCollision({
    primary: { position: at.t.position, velocity: at.t.velocity, sigmaRicKm: sigma },
    secondary: { position: at.s.position, velocity: at.s.velocity, sigmaRicKm: sigma },
    hardBodyRadiusKm: hbrKm,
  });
  return {
    missKm: at.d,
    pc: Number.isFinite(pc) ? pc : 0,
    ricKm,
    tcaShiftSeconds: tBest,
  };
}

/* ------------------------------------------------------------
   Pc sensitivity / probability dilution
   ------------------------------------------------------------ */

function pcAtScale(
  targetState: StateVector,
  secondaryState: StateVector,
  sigma: Vec3,
  hbrKm: number,
  scale: number
): number {
  const s: Vec3 = [sigma[0] * scale, sigma[1] * scale, sigma[2] * scale];
  const pc = probabilityOfCollision({
    primary: { position: targetState.position, velocity: targetState.velocity, sigmaRicKm: s },
    secondary: { position: secondaryState.position, velocity: secondaryState.velocity, sigmaRicKm: s },
    hardBodyRadiusKm: hbrKm,
  });
  return Number.isFinite(pc) ? pc : 0;
}

/**
 * Pc as a function of a σ scale factor applied to both objects'
 * assumed covariance (the covariance itself scales by scale²) — the
 * classic probability-dilution curve.
 */
export function pcSensitivity(
  targetState: StateVector,
  secondaryState: StateVector,
  sigmaRicKm: [number, number, number],
  hardBodyRadiusM: number,
  scales: readonly number[] = DEFAULT_SENSITIVITY_SCALES
): PcSensitivityPoint[] {
  if (!isUsableState(targetState) || !isUsableState(secondaryState)) return [];
  const sigma = sanitizeSigma(sigmaRicKm);
  const hbrKm = sanitizeHbrKm(hardBodyRadiusM);
  return cleanList(scales, DEFAULT_SENSITIVITY_SCALES)
    .sort((a, b) => a - b)
    .map((scale) => ({ scale, pc: pcAtScale(targetState, secondaryState, sigma, hbrKm, scale) }));
}

/**
 * Locate the Pc peak over σ scale (log grid 0.05×-50×, 61 points)
 * and flag probability dilution: the nominal covariance is diluted
 * when Pc DECREASES as the covariance grows there (peak below 1×).
 */
export function pcDilution(
  targetState: StateVector,
  secondaryState: StateVector,
  sigmaRicKm: [number, number, number],
  hardBodyRadiusM: number
): PcDilution {
  if (!isUsableState(targetState) || !isUsableState(secondaryState)) {
    return { nominalPc: 0, peakScale: 1, peakPc: 0, diluted: false };
  }
  const sigma = sanitizeSigma(sigmaRicKm);
  const hbrKm = sanitizeHbrKm(hardBodyRadiusM);
  const nominalPc = pcAtScale(targetState, secondaryState, sigma, hbrKm, 1);
  let peakScale = 1;
  let peakPc = nominalPc;
  const steps = 60;
  const lo = Math.log(0.05);
  const hi = Math.log(50);
  for (let i = 0; i <= steps; i++) {
    const scale = Math.exp(lo + ((hi - lo) * i) / steps);
    const pc = pcAtScale(targetState, secondaryState, sigma, hbrKm, scale);
    if (pc > peakPc) {
      peakPc = pc;
      peakScale = scale;
    }
  }
  // Local slope at the nominal covariance decides the region.
  const above = pcAtScale(targetState, secondaryState, sigma, hbrKm, 1.05);
  const diluted = nominalPc > 0 && above < nominalPc && peakScale < 1;
  return { nominalPc, peakScale, peakPc, diluted };
}
