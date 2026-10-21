import {
  EARTH_EQUATORIAL_RADIUS_KM,
  MU_EARTH_KM3_S2,
  REENTRY_ALTITUDE_KM,
  SECONDS_PER_DAY,
} from "@/lib/orbital";
import { F107_ELEVATED_MAX, F107_LOW_MAX } from "@/lib/spaceweather";

/* ============================================================
   SpaceDebris — orbital lifetime & disposal compliance (Session 6)

   PURE MODULE: no React, no network, no Claude. Deterministic
   first-principles physics, unit-tested in node.

   Why it exists
   Starlink's ~550 km design altitude is chosen so that a failed
   satellite re-enters by natural drag in roughly five years
   (SpaceX's public figure; this model brackets it: ≈ 5.8 / 2.9 /
   1.2 y at LOW / MEAN / HIGH activity for B = 0.04 m²/kg), and
   the FCC (Second Report & Order, Sept 2022) requires LEO
   spacecraft to be disposed of within 5 years of end of mission.
   The older IADC / NASA guideline was 25 years. This module
   integrates a circular-orbit drag decay so the dashboard can say,
   for a given altitude and ballistic coefficient, which rule a
   passive (no-propulsion) disposal would satisfy.

   Model
   1. Atmosphere — static exponential model, Vallado "Fundamentals
      of Astrodynamics and Applications", Table 8-4 (mean solar
      activity):  ρ(h) = ρ0 · exp(−(h − h0) / H)  using the table
      row at or below h. Below 150 km the 150 km row is used; above
      1000 km the 1000 km row is extrapolated.
   2. Solar activity — the whole profile is multiplied by a CRUDE
      constant factor (LOW 0.5 / MEAN 1 / HIGH 2.5). Real
      thermospheric density varies by an order of magnitude or more
      over a solar cycle, increasingly so with altitude; the ×0.5 /
      ×2.5 factors are a crude envelope, not a solar-cycle model.
   3. Decay — circular orbit, drag only (energy loss rate):
         da/dt = −√(μ·a) · ρ(a − Re) · B,    B = Cd·A/m  (m²/kg)
      Derivation: E = −μ/(2a), dE/dt = −D·v = −½·ρ·v³·B,
      v² = μ/a  ⇒  da/dt = (2a²/μ)·dE/dt = −ρ·B·√(μ·a).
   4. Integration — classical RK4 with an adaptive step
         dt = clamp(0.002 · h / |da/dt|, 60 s, 30 days)
      where h = a − Re, so each step changes the altitude by
      ≤ 0.2 % (stricter than 0.2 % of a — drag depends on h, not
      a). Stop at h ≤ 120 km (reentry; the step that crosses is
      re-run as FINAL_STEP_SUBSTEPS fine RK4 sub-steps and the
      crossing time is linearly interpolated inside the sub-step
      that crosses) or at the cap.

   ASSUMPTIONS (also printed on screen by DisposalCompliance.tsx)
   - Circular orbit at the object's MEAN altitude; eccentric
     orbits decay faster than this (perigee drag dominates).
   - Constant B (no attitude / tumbling changes), constant
     activity factor (no solar-cycle variation), no lift, no J2,
     no co-rotating atmosphere (~few % effect on drag).
   - Natural decay only: assumes NO propulsive deorbit.
   - Years are Julian years (365.25 d).
   Order-of-magnitude tool — not a reentry prediction.
   ============================================================ */

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/** Default integration cap (years). Lifetime is null beyond this. */
export const LIFETIME_CAP_YEARS = 500;
/** FCC LEO post-mission disposal rule (adopted Sept 2022). */
export const FCC_DISPOSAL_YEARS = 5;
/** Legacy IADC / NASA-STD-8719.14 post-mission disposal guideline. */
export const LEGACY_DISPOSAL_YEARS = 25;
/** Julian year in seconds. */
export const SECONDS_PER_JULIAN_YEAR = 365.25 * SECONDS_PER_DAY;
/** Adaptive-step bounds (seconds). */
export const MIN_STEP_SECONDS = 60;
export const MAX_STEP_SECONDS = 30 * SECONDS_PER_DAY;
/** Maximum fractional altitude change per integration step. */
export const STEP_ALTITUDE_FRACTION = 0.002;
/** Maximum number of points returned in LifetimeResult.curve. */
export const CURVE_MAX_SAMPLES = 200;
/** Hard safety stop on the integrator (never reached in practice). */
const MAX_STEPS = 250_000;
/** RK4 sub-steps used to locate the 120 km crossing inside the last step. */
const FINAL_STEP_SUBSTEPS = 64;

/** Altitudes (km) used by lifetimeLadder() by default. */
export const DEFAULT_LADDER_ALTITUDES_KM: ReadonlyArray<number> = [
  300, 350, 400, 450, 500, 550, 600, 650, 700, 800, 900, 1000,
];

/**
 * Altitude band (km) spanned by the public Starlink shells (Gen1
 * 540-570 km, Gen2 525-535 km) plus the ~480 km operating altitude the
 * 550 km shell is being lowered to through 2026. Used only to highlight rows.
 */
export const STARLINK_SHELL_BAND_KM = { min: 480, max: 570 } as const;

/* ------------------------------------------------------------
   Atmosphere — Vallado Table 8-4 (mean solar activity)
   ------------------------------------------------------------ */

export interface AtmosphereRow {
  /** Base altitude h0 (km). */
  altKm: number;
  /** Density at h0 (kg/m³). */
  rho0: number;
  /** Scale height H (km). */
  scaleHeightKm: number;
}

/**
 * Exponential atmosphere rows, ascending by altitude. Values exactly
 * as published in Vallado, Table 8-4 (150-1000 km portion).
 */
export const ATMOSPHERE_TABLE: ReadonlyArray<AtmosphereRow> = [
  { altKm: 150, rho0: 2.07e-9, scaleHeightKm: 22.523 },
  { altKm: 180, rho0: 5.464e-10, scaleHeightKm: 29.74 },
  { altKm: 200, rho0: 2.789e-10, scaleHeightKm: 37.105 },
  { altKm: 250, rho0: 7.248e-11, scaleHeightKm: 45.546 },
  { altKm: 300, rho0: 2.418e-11, scaleHeightKm: 53.628 },
  { altKm: 350, rho0: 9.518e-12, scaleHeightKm: 53.298 },
  { altKm: 400, rho0: 3.725e-12, scaleHeightKm: 58.515 },
  { altKm: 450, rho0: 1.585e-12, scaleHeightKm: 60.828 },
  { altKm: 500, rho0: 6.967e-13, scaleHeightKm: 63.822 },
  { altKm: 600, rho0: 1.454e-13, scaleHeightKm: 71.835 },
  { altKm: 700, rho0: 3.614e-14, scaleHeightKm: 88.667 },
  { altKm: 800, rho0: 1.17e-14, scaleHeightKm: 124.64 },
  { altKm: 900, rho0: 5.245e-15, scaleHeightKm: 181.05 },
  { altKm: 1000, rho0: 3.019e-15, scaleHeightKm: 268.0 },
];

/** Row whose base altitude is at or below h (150 row below 150 km). */
function atmosphereRowFor(altKm: number): AtmosphereRow {
  let row = ATMOSPHERE_TABLE[0];
  for (let i = 1; i < ATMOSPHERE_TABLE.length; i++) {
    if (ATMOSPHERE_TABLE[i].altKm <= altKm) row = ATMOSPHERE_TABLE[i];
    else break;
  }
  return row;
}

/**
 * Atmospheric density (kg/m³) at geodetic-ish height h (km above
 * EARTH_EQUATORIAL_RADIUS_KM), scaled by activityFactor.
 * Returns 0 for a non-finite altitude or a non-positive factor.
 */
export function atmosphericDensity(altKm: number, activityFactor = 1): number {
  if (!Number.isFinite(altKm)) return 0;
  if (!Number.isFinite(activityFactor) || activityFactor <= 0) return 0;
  const row = atmosphereRowFor(altKm);
  return row.rho0 * Math.exp(-(altKm - row.altKm) / row.scaleHeightKm) * activityFactor;
}

/* ------------------------------------------------------------
   Solar activity (crude envelope)
   ------------------------------------------------------------ */

export type SolarActivity = "LOW" | "MEAN" | "HIGH";

export const SOLAR_ACTIVITY_LEVELS: ReadonlyArray<SolarActivity> = ["LOW", "MEAN", "HIGH"];

/**
 * Multiplier on the mean-activity density profile. A CRUDE envelope:
 * real thermospheric density varies by an order of magnitude or more
 * between solar minimum and maximum, increasingly so with altitude;
 * the ×0.5 / ×2.5 factors are a crude envelope.
 */
export const ACTIVITY_FACTOR: Record<SolarActivity, number> = {
  LOW: 0.5,
  MEAN: 1,
  HIGH: 2.5,
};

/**
 * F10.7 (sfu) → activity bucket, on the SAME bands the Space Weather panel
 * uses for its drag regime (lib/spaceweather): < 100 LOW, ≥ 200 HIGH
 * (solar-maximum-class flux), else MEAN. null / NaN → MEAN. The input is a
 * daily value; lifetime models normally use an 81-day mean, so the panel
 * labels it as a suggestion the user can override.
 */
export function activityFromF107(f107: number | null): SolarActivity {
  if (f107 === null || !Number.isFinite(f107)) return "MEAN";
  if (f107 < F107_LOW_MAX) return "LOW";
  if (f107 >= F107_ELEVATED_MAX) return "HIGH";
  return "MEAN";
}

/* ------------------------------------------------------------
   Ballistic coefficient presets (B = Cd·A/m, m²/kg)
   ------------------------------------------------------------ */

export interface BallisticPreset {
  id: string;
  label: string;
  /** B = Cd·A/m (m²/kg). Larger B → faster decay. */
  bcM2PerKg: number;
  note: string;
}

export const BALLISTIC_PRESETS: ReadonlyArray<BallisticPreset> = [
  {
    id: "starlink",
    label: "Starlink-class (B 0.04 m²/kg)",
    bcM2PerKg: 0.04,
    note: "large solar array, low mass — public estimate",
  },
  {
    id: "cubesat-3u",
    label: "3U CubeSat (B 0.03)",
    bcM2PerKg: 0.03,
    note: "~4 kg with deployed panels, Cd 2.2 — order-of-magnitude estimate",
  },
  {
    id: "bus-1000kg",
    label: "1,000 kg bus (B 0.012)",
    bcM2PerKg: 0.012,
    note: "~5 m² mean cross-section, Cd 2.2 — generic, order-of-magnitude",
  },
  {
    id: "dense-debris",
    label: "Dense fragment (B 0.005)",
    bcM2PerKg: 0.005,
    note: "compact, high area-density fragment — order-of-magnitude",
  },
];

/** Accepted range for a user-entered B (m²/kg). */
export const BC_MIN_M2_PER_KG = 0.0001;
export const BC_MAX_M2_PER_KG = 1;

export function findBallisticPreset(id: string): BallisticPreset | null {
  return BALLISTIC_PRESETS.find((p) => p.id === id) ?? null;
}

/* ------------------------------------------------------------
   Decay rate
   ------------------------------------------------------------ */

/**
 * da/dt (km/s, NEGATIVE = shrinking) for a circular orbit of
 * semi-major axis aKm.
 *
 * Units, explicitly:
 *   √(μ·a)        μ [km³/s²] · a [km]          → km²/s
 *   ρ             kg/m³ × 1e9                  → kg/km³   (1 km³ = 1e9 m³)
 *   B             m²/kg × 1e-6                 → km²/kg   (1 m² = 1e-6 km²)
 *   product       km²/s · kg/km³ · km²/kg      → km/s
 * so da/dt = −√(μ·a) · (ρ·1e9) · (B·1e-6) = −√(μ·a) · ρ · B · 1e3.
 */
function dadtKmPerSec(aKm: number, bcM2PerKg: number, activityFactor: number): number {
  if (!(aKm > 0)) return 0;
  const rhoKgPerKm3 = atmosphericDensity(aKm - EARTH_EQUATORIAL_RADIUS_KM, activityFactor) * 1e9;
  const bcKm2PerKg = bcM2PerKg * 1e-6;
  return -Math.sqrt(MU_EARTH_KM3_S2 * aKm) * rhoKgPerKm3 * bcKm2PerKg;
}

/**
 * Model decay rate (km/day, POSITIVE = shrinking — same sign
 * convention as lib/orbital decayEstimate().decayKmPerDay) for a
 * circular orbit at altKm.
 */
export function circularDecayRateKmPerDay(
  altKm: number,
  bcM2PerKg: number,
  activityFactor = 1
): number {
  if (!Number.isFinite(altKm) || !Number.isFinite(bcM2PerKg) || bcM2PerKg <= 0) return 0;
  const rate = -dadtKmPerSec(EARTH_EQUATORIAL_RADIUS_KM + altKm, bcM2PerKg, activityFactor);
  return Number.isFinite(rate) ? rate * SECONDS_PER_DAY : 0;
}

/**
 * Invert the decay law: the B that would reproduce an OBSERVED decay
 * rate (km/day, positive = shrinking — e.g. from a TLE's ṅ term) at
 * altKm under the given atmosphere. null when the observation is not a
 * decay, the density is zero, or the result is not finite. Noisy:
 * meaningless for station-kept or recently maneuvered satellites.
 */
export function impliedBallisticCoefficient(
  altKm: number,
  observedDecayKmPerDay: number,
  activityFactor = 1
): number | null {
  if (!Number.isFinite(altKm) || altKm <= REENTRY_ALTITUDE_KM) return null;
  if (!Number.isFinite(observedDecayKmPerDay) || observedDecayKmPerDay <= 0) return null;
  // Model rate for B = 1 m²/kg; the law is linear in B.
  const unitRate = circularDecayRateKmPerDay(altKm, 1, activityFactor);
  if (!(unitRate > 0)) return null;
  const b = observedDecayKmPerDay / unitRate;
  return Number.isFinite(b) && b > 0 ? b : null;
}

/* ------------------------------------------------------------
   Lifetime integration
   ------------------------------------------------------------ */

export interface LifetimePoint {
  years: number;
  altKm: number;
}

export interface LifetimeResult {
  startAltitudeKm: number;
  /** Years until h ≤ 120 km; null when the cap is hit first. */
  lifetimeYears: number | null;
  /** ISO timestamp of the predicted reentry; null when capped. */
  reentryDate: string | null;
  capped: boolean;
  /** Altitude history, ≤ CURVE_MAX_SAMPLES points, first + last kept. */
  curve: LifetimePoint[];
  /** Number of RK4 steps taken. */
  steps: number;
  activity: SolarActivity;
  bcM2PerKg: number;
}

/**
 * Thin an altitude history to ≤ maxSamples points, evenly spaced
 * along the curve's normalised arc length (time and altitude each
 * scaled to [0, 1]) so the long flat early decay and the final
 * plunge both keep resolution. First and last points always kept.
 */
function thinCurve(ts: number[], hs: number[], maxSamples: number): LifetimePoint[] {
  const n = ts.length;
  const toPoint = (i: number): LifetimePoint => ({
    years: ts[i] / SECONDS_PER_JULIAN_YEAR,
    altKm: hs[i],
  });
  if (n <= maxSamples) return ts.map((_, i) => toPoint(i));

  const tSpan = ts[n - 1] - ts[0] || 1;
  let hMin = hs[0];
  let hMax = hs[0];
  for (const h of hs) {
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const hSpan = hMax - hMin || 1;

  const s: number[] = new Array(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) {
    const dt = (ts[i] - ts[i - 1]) / tSpan;
    const dh = (hs[i] - hs[i - 1]) / hSpan;
    s[i] = s[i - 1] + Math.sqrt(dt * dt + dh * dh);
  }
  const total = s[n - 1];
  const out: LifetimePoint[] = [toPoint(0)];
  if (total > 0) {
    const spacing = total / (maxSamples - 1);
    let nextTarget = spacing;
    for (let i = 1; i < n - 1 && out.length < maxSamples - 1; i++) {
      if (s[i] >= nextTarget) {
        out.push(toPoint(i));
        nextTarget = (Math.floor(s[i] / spacing) + 1) * spacing;
      }
    }
  }
  out.push(toPoint(n - 1));
  return out;
}

/**
 * Natural-decay lifetime of a circular orbit.
 *
 * @param startAltitudeKm  altitude above EARTH_EQUATORIAL_RADIUS_KM (finite)
 * @param bcM2PerKg        B = Cd·A/m (finite, ≥ 0; 0 = no drag → capped)
 * @param activity         solar-activity bucket (density multiplier)
 * @param start            epoch of the start state (reentry date anchor)
 * @param capYears         integration cap (default 500)
 * @throws RangeError for a non-finite altitude or a negative / non-finite B
 */
export function estimateLifetime(
  startAltitudeKm: number,
  bcM2PerKg: number,
  activity: SolarActivity,
  start: Date = new Date(),
  capYears = LIFETIME_CAP_YEARS
): LifetimeResult {
  if (!Number.isFinite(startAltitudeKm)) {
    throw new RangeError("estimateLifetime: startAltitudeKm must be a finite number.");
  }
  if (!Number.isFinite(bcM2PerKg) || bcM2PerKg < 0) {
    throw new RangeError("estimateLifetime: bcM2PerKg must be a finite number ≥ 0.");
  }
  const cap = Number.isFinite(capYears) && capYears > 0 ? capYears : LIFETIME_CAP_YEARS;
  const factor = ACTIVITY_FACTOR[activity] ?? 1;
  const startMs = Number.isFinite(start.getTime()) ? start.getTime() : 0;
  const capSeconds = cap * SECONDS_PER_JULIAN_YEAR;
  const re = EARTH_EQUATORIAL_RADIUS_KM;

  const base = { startAltitudeKm, activity, bcM2PerKg };

  // Already at / below the reentry interface.
  if (startAltitudeKm <= REENTRY_ALTITUDE_KM) {
    return {
      ...base,
      lifetimeYears: 0,
      reentryDate: new Date(startMs).toISOString(),
      capped: false,
      curve: [{ years: 0, altKm: startAltitudeKm }],
      steps: 0,
    };
  }

  // No drag at all: the orbit never decays in this model.
  if (bcM2PerKg === 0) {
    return {
      ...base,
      lifetimeYears: null,
      reentryDate: null,
      capped: true,
      curve: [
        { years: 0, altKm: startAltitudeKm },
        { years: cap, altKm: startAltitudeKm },
      ],
      steps: 0,
    };
  }

  const f = (a: number): number => dadtKmPerSec(a, bcM2PerKg, factor);
  /** One classical RK4 step of da/dt = f(a); k1 = f(a0) may be passed in. */
  const rk4 = (a0: number, dt: number, k1: number = f(a0)): number => {
    const k2 = f(a0 + 0.5 * dt * k1);
    const k3 = f(a0 + 0.5 * dt * k2);
    const k4 = f(a0 + dt * k3);
    return a0 + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
  };

  const ts: number[] = [0];
  const hs: number[] = [startAltitudeKm];
  let a = re + startAltitudeKm;
  let t = 0;
  let steps = 0;
  let reentered = false;

  while (t < capSeconds && steps < MAX_STEPS) {
    const h = a - re;
    const k1 = f(a);
    const absRate = Math.abs(k1);
    let dt =
      absRate > 0 ? (STEP_ALTITUDE_FRACTION * Math.max(h, 1)) / absRate : MAX_STEP_SECONDS;
    if (!Number.isFinite(dt)) dt = MAX_STEP_SECONDS;
    dt = Math.min(MAX_STEP_SECONDS, Math.max(MIN_STEP_SECONDS, dt));
    if (t + dt > capSeconds) dt = capSeconds - t;

    let aNext = rk4(a, dt, k1);
    steps++;

    if (!Number.isFinite(aNext - re)) break;
    if (aNext - re <= REENTRY_ALTITUDE_KM) {
      // This step reaches the 120 km interface. Re-run it as fine RK4
      // sub-steps and interpolate linearly inside the sub-step that
      // crosses. Interpolating across the whole step breaks down when
      // the 60 s floor exceeds the 0.2 % rule (very large B at HIGH
      // activity): the step overshoots far below the surface through
      // the 150 km row's downward extrapolation, the fraction collapses
      // to ~0 and the crossing lands on the step start.
      const sub = dt / FINAL_STEP_SUBSTEPS;
      let aSub = a;
      let tSub = 0;
      let crossAt: number | null = null;
      for (let i = 0; i < FINAL_STEP_SUBSTEPS; i++) {
        const aSubNext = rk4(aSub, sub);
        const hSub = aSub - re;
        const hSubNext = aSubNext - re;
        if (!(hSubNext > REENTRY_ALTITUDE_KM)) {
          const drop = hSub - hSubNext;
          const frac =
            drop > 0 && Number.isFinite(drop)
              ? Math.min(1, Math.max(0, (hSub - REENTRY_ALTITUDE_KM) / drop))
              : 1;
          crossAt = tSub + sub * frac;
          break;
        }
        aSub = aSubNext;
        tSub += sub;
      }
      if (crossAt !== null) {
        t += crossAt;
        // Keep curve time strictly increasing if the crossing falls
        // within float resolution of the previous sample.
        if (ts.length > 1 && t <= ts[ts.length - 1]) {
          ts.pop();
          hs.pop();
        }
        ts.push(t);
        hs.push(REENTRY_ALTITUDE_KM);
        reentered = true;
        break;
      }
      // The finer integration stays above 120 km over this step
      // (the single coarse step over-predicted the drop): keep it.
      aNext = aSub;
    }
    t += dt;
    a = aNext;
    ts.push(t);
    hs.push(aNext - re);
  }

  const curve = thinCurve(ts, hs, CURVE_MAX_SAMPLES);

  if (!reentered) {
    return {
      ...base,
      lifetimeYears: null,
      reentryDate: null,
      capped: true,
      curve,
      steps,
    };
  }

  const lifetimeYears = t / SECONDS_PER_JULIAN_YEAR;
  return {
    ...base,
    lifetimeYears,
    reentryDate: new Date(startMs + t * 1000).toISOString(),
    capped: false,
    curve,
    steps,
  };
}

/* ------------------------------------------------------------
   Disposal-rule checks
   ------------------------------------------------------------ */

export interface DisposalCheck<R extends string> {
  rule: R;
  pass: boolean;
}

/** PASS when natural decay completes within 5 years (null = capped → FAIL). */
export function fccFiveYearCheck(
  lifetimeYears: number | null
): DisposalCheck<"FCC 5-year post-mission disposal (2022)"> {
  return {
    rule: "FCC 5-year post-mission disposal (2022)",
    pass:
      lifetimeYears !== null &&
      Number.isFinite(lifetimeYears) &&
      lifetimeYears <= FCC_DISPOSAL_YEARS,
  };
}

/** PASS when natural decay completes within 25 years (null = capped → FAIL). */
export function legacy25YearCheck(
  lifetimeYears: number | null
): DisposalCheck<"IADC / NASA 25-year guideline"> {
  return {
    rule: "IADC / NASA 25-year guideline",
    pass:
      lifetimeYears !== null &&
      Number.isFinite(lifetimeYears) &&
      lifetimeYears <= LEGACY_DISPOSAL_YEARS,
  };
}

/* ------------------------------------------------------------
   Ladder
   ------------------------------------------------------------ */

export interface LadderRow {
  altKm: number;
  lifetimeYears: number | null;
}

/** Lifetime at each altitude for one B and activity (null = capped). */
export function lifetimeLadder(
  bcM2PerKg: number,
  activity: SolarActivity,
  altitudes: ReadonlyArray<number> = DEFAULT_LADDER_ALTITUDES_KM
): LadderRow[] {
  const epoch = new Date(0); // lifetime is epoch-independent
  return altitudes
    .filter((alt) => Number.isFinite(alt))
    .map((altKm) => ({
      altKm,
      lifetimeYears: estimateLifetime(altKm, bcM2PerKg, activity, epoch).lifetimeYears,
    }));
}

/* ------------------------------------------------------------
   Display helpers (pure; used by the panel, unit-tested)
   ------------------------------------------------------------ */

export function inStarlinkShellBand(altKm: number): boolean {
  return (
    Number.isFinite(altKm) &&
    altKm >= STARLINK_SHELL_BAND_KM.min &&
    altKm <= STARLINK_SHELL_BAND_KM.max
  );
}

/** Disposal-rule limits (years) that formatLifetime() must not blur. */
const RULE_LIMITS_YEARS: ReadonlyArray<number> = [FCC_DISPOSAL_YEARS, LEGACY_DISPOSAL_YEARS];
/** Within this many years of a rule limit, formatLifetime() shows 2 dp. */
const NEAR_RULE_LIMIT_YEARS = 0.05;

/**
 * Years as text: 1 dp, or 2 dp within NEAR_RULE_LIMIT_YEARS of the
 * 5- or 25-year limit. PASS means lifetime ≤ limit, so a value just
 * above a limit never rounds onto it (5.04 → "5.04", 5.001 → "5.01",
 * never "5.0" / "5.00" beside a FAIL badge): the shown number is
 * ≤ the limit exactly when the rule check passes.
 */
function yearsText(years: number): string {
  for (const limit of RULE_LIMITS_YEARS) {
    if (Math.abs(years - limit) < NEAR_RULE_LIMIT_YEARS) {
      const text = years.toFixed(2);
      return years > limit && Number(text) <= limit ? (limit + 0.01).toFixed(2) : text;
    }
  }
  return years.toFixed(1);
}

/**
 * "3.4 y" (1 dp; 2 dp near the 5- and 25-year limits so the number
 * agrees with fccFiveYearCheck / legacy25YearCheck) · "12 d" below
 * 0.1 y (1 dp would read "0.0 y") · "> 500 y" when capped. Never
 * returns NaN text.
 */
export function formatLifetime(
  lifetimeYears: number | null,
  capYears = LIFETIME_CAP_YEARS
): string {
  if (lifetimeYears === null) return `> ${capYears} y`;
  if (!Number.isFinite(lifetimeYears) || lifetimeYears < 0) return "—";
  if (lifetimeYears < 0.1) {
    const days = lifetimeYears * 365.25;
    return days < 1 ? "< 1 d" : `${Math.round(days)} d`;
  }
  return `${yearsText(lifetimeYears)} y`;
}

/** ISO timestamp → "YYYY-MM" (UTC); "—" for null / unparseable. */
export function formatReentryMonth(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${m < 10 ? "0" : ""}${m}`;
}
