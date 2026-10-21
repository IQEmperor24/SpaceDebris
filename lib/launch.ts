import type { SatRec } from "satellite.js";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import {
  argumentOfLatitude,
  circularOrbitState,
  degToRad,
  minutesSinceEpoch,
  normalizeDeg360,
  parseTle,
  propagateMinutes,
  radToDeg,
  raanThroughPosition,
  siteEci,
  tleElements,
  twoBodyPropagate,
  type StateVector,
} from "@/lib/orbital";

/* ============================================================
   SpaceDebris — Launch collision-avoidance (COLA) screening
   (Session 6, Feature 3)

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic. Runs
   identically on the Node runtime (GET /api/cola) and in the
   browser (the panel uses the catalogs + reachability check).
   Every physics primitive comes from lib/orbital.ts — this file
   only builds the simplified launch geometry and orchestrates the
   screen.

   What a launch COLA screen is
   Before every launch the range screens each second of the launch
   window: if the ascending vehicle (or what it deploys) would pass
   too close to a tracked object, that second is blacked out. This
   module computes a SIMPLIFIED, minute-resolution version of that
   against the catalog sample the dashboard already holds.

   Model (every simplification is printed on screen)
   1. Orbit plane. At liftoff time T0 the plane of the target orbit
      (inclination i) must contain the launch site:
        RAAN = raanThroughPosition(siteEci(site, T0), i)
      That helper returns the ASCENDING (northbound) solution. Two
      cases fly the other, DESCENDING (southbound) solution of
      sin(Ω − α) = s, i.e. Ω' = 2α + 180° − Ω:
        - SLC-4E Vandenberg: every Vandenberg launch flies south
          over the Pacific (a northbound ascent would overfly land).
        - Retrograde orbits (i > 90°, e.g. SSO) from any site: the
          Florida polar corridor and Starbase both fly south.
      No such plane exists when |site latitude| > i (or > 180° − i
      for retrograde orbits); insertionState() then returns null and
      the route answers 400.
   2. Insertion. Instantaneous insertion into the CIRCULAR target
      orbit at T0 + INSERTION_DELAY_S (T+9 min), DOWNRANGE_DEG (20°)
      of orbital arc past the site's argument of latitude. Real
      vehicles insert into a lower transfer / parking orbit first
      (Starlink, for example, deploys well below its operational
      shell and raises with its own thrusters) — so this screens the
      TARGET orbit, not the real deployment orbit.
   3. Coast. The inserted vehicle is propagated two-body (Kepler,
      lib/orbital twoBodyPropagate) for SCREEN_AFTER_INSERTION_S
      (20 min) and sampled every SCREEN_STEP_S (30 s).
   4. Screen. At every sample, each catalog candidate is propagated
      with SGP4. Within each 30 s cell (±15 s around the sample,
      clamped to the coast) the closest approach is refined with
      straight-line relative motion:
        Δr(t) = Δr + Δv·t,  t* = −(Δr·Δv)/|Δv|²,  d = |Δr(t*)|
      Curvature error of that refinement: for the approaches that
      matter (miss < 25 km) the separation inside a cell (|t| ≤ 15 s)
      is at most ≈ 25 km + 15.3 km/s × 15 s ≈ 255 km, so the
      differential (gravity-gradient) acceleration is at most
      2μ/r³·|Δr| ≈ 2 × 1.27e-6 s⁻² × 255 km ≈ 6.5e-4 km/s² at 420 km
      (the candidate's SGP4 J2 term, absent from the two-body
      vehicle, adds ≲ 2.5e-5 km/s²). The error is therefore
      ≤ ½·a·t² ≈ 0.08 km worst case; measured against a 1 s
      brute-force reference it stays < 0.05 km — far below the 5 km
      NO-GO threshold, whereas a raw 30 s sample can miss a 15 km/s
      crossing by > 100 km.
   5. Grade. NO-GO when the minimum miss < COLA_RED_KM (5 km),
      CAUTION when < COLA_YELLOW_KM (25 km), otherwise GO.
      No covariance, no Pc: a pure miss-distance screen.

   Candidate prefilter
   An object can only come close if its altitude range overlaps the
   target altitude: PERIAPSIS ≤ alt + ALT_BAND_KM and APOAPSIS ≥
   alt − ALT_BAND_KM (gp strings, parseFloat + isFinite; if a row's
   strings are unusable the TLE-derived apsides are used instead).
   Satrecs are parsed ONCE per screen.

   Performance — why this is fast (first principles)
   Launch minutes are 60 s apart and coast samples 30 s apart, so
   the absolute sample times of every launch minute fall on ONE
   shared 30 s grid anchored at windowStart + INSERTION_DELAY_S:
     sample (m, k)  ↔  grid index j = m·(60·stepMinutes/30) + k
   Launch minute m needs grid indices [2m, 2m + 40]; minute m + 1
   needs only TWO new ones. Candidate states are therefore cached
   in a 41-slot ring of Float64Arrays (position + velocity per
   candidate) and each grid point is propagated exactly once:
     120-min window → 279 SGP4 calls per candidate instead of
     120 × 41 = 4,920 (17.6× fewer), and the inner distance loop is
     allocation-free arithmetic on typed arrays.
   screenOneLaunch() is the straightforward per-launch reference
   implementation (no cache); the node tests cross-check the
   optimized window walk against it minute by minute.

   Time budget
   The walk checks a wall-clock budget (default 20 s) before every
   launch minute after the first; when exceeded it stops and sets
   truncated = true. Minutes not screened are simply absent from
   `minutes` (the UI greys them out).
   ============================================================ */

/* ------------------------------------------------------------
   Catalogs
   ------------------------------------------------------------ */

export interface LaunchSite {
  id: string;
  label: string;
  latitudeDeg: number;
  longitudeDeg: number;
  heightKm: number;
  /**
   * True when every ascent from this site flies SOUTH (descending
   * pass). SLC-4E: Vandenberg launches go south over the Pacific.
   * Omitted / false = northbound for prograde orbits.
   */
  southboundOnly?: boolean;
}

export const LAUNCH_SITES: LaunchSite[] = [
  {
    id: "slc-40",
    label: "SLC-40 · Cape Canaveral SFS",
    latitudeDeg: 28.5619,
    longitudeDeg: -80.5772,
    heightKm: 0.003,
  },
  {
    id: "lc-39a",
    label: "LC-39A · Kennedy Space Center",
    latitudeDeg: 28.6084,
    longitudeDeg: -80.6043,
    heightKm: 0.003,
  },
  {
    id: "slc-4e",
    label: "SLC-4E · Vandenberg SFB",
    latitudeDeg: 34.632,
    longitudeDeg: -120.6108,
    heightKm: 0.1,
    southboundOnly: true,
  },
  {
    id: "starbase",
    label: "Starbase · Boca Chica",
    latitudeDeg: 25.9972,
    longitudeDeg: -97.155,
    heightKm: 0.001,
  },
];

export interface TargetOrbit {
  id: string;
  label: string;
  /** Circular-orbit altitude above the equatorial radius (km). */
  altitudeKm: number;
  inclinationDeg: number;
}

export const TARGET_ORBITS: TargetOrbit[] = [
  { id: "starlink-550", label: "Starlink 550 km / 53° (Gen1 design shell)", altitudeKm: 550, inclinationDeg: 53 },
  { id: "starlink-gen2-530", label: "Starlink Gen2 530 km / 43°", altitudeKm: 530, inclinationDeg: 43 },
  { id: "iss", label: "ISS 420 km / 51.64°", altitudeKm: 420, inclinationDeg: 51.64 },
  { id: "sso-560", label: "SSO 560 km / 97.6°", altitudeKm: 560, inclinationDeg: 97.6 },
];

/** Launch-window lengths the API and the panel accept (minutes). */
export const COLA_WINDOW_OPTIONS: readonly number[] = [60, 120, 240];

/* ------------------------------------------------------------
   Model constants (returned verbatim in ColaResult.assumptions)
   ------------------------------------------------------------ */

/** Liftoff → insertion (s): T+9 min. */
export const INSERTION_DELAY_S = 540;
/** Argument-of-latitude offset between the site and the insertion point (deg). */
export const DOWNRANGE_DEG = 20;
/** Post-insertion coast that is screened (s): 20 min. */
export const SCREEN_AFTER_INSERTION_S = 1200;
/** Coast sampling step (s). */
export const SCREEN_STEP_S = 30;
/** Altitude band around the target altitude for the candidate prefilter (km). */
export const ALT_BAND_KM = 50;
/** Miss distance below which a launch minute is NO-GO (km). */
export const COLA_RED_KM = 5;
/** Miss distance below which a launch minute is CAUTION (km). */
export const COLA_YELLOW_KM = 25;

/** Hard caps on the window walk (validated in screenLaunchWindow). */
export const COLA_MAX_WINDOW_MINUTES = 1440;
export const COLA_MAX_STEP_MINUTES = 60;

export const DEFAULT_COLA_OPTIONS = {
  stepMinutes: 1,
  timeBudgetMs: 20000,
} as const;

/* ------------------------------------------------------------
   Result types
   ------------------------------------------------------------ */

export type ColaStatus = "GO" | "CAUTION" | "NO-GO";
export type AscentDirection = "NORTHBOUND" | "SOUTHBOUND";

export interface ColaMinute {
  /** Liftoff time T0 (ISO). */
  launchTime: string;
  status: ColaStatus;
  /** Closest approach over the screened coast (km); null = nothing screened. */
  minMissKm: number | null;
  objectName: string | null;
  noradId: string | null;
  /** Time of that closest approach (ISO). */
  tca: string | null;
}

export interface ColaSummary {
  go: number;
  caution: number;
  noGo: number;
  /** First run of consecutive GO minutes (start = its first liftoff time). */
  nextClearWindow: { start: string; minutes: number } | null;
}

export interface ColaAssumptions {
  insertionDelayS: number;
  downrangeDeg: number;
  screenAfterInsertionS: number;
  screenStepS: number;
  altBandKm: number;
  redKm: number;
  yellowKm: number;
}

export interface ColaResult {
  site: LaunchSite;
  orbit: TargetOrbit;
  windowStart: string;
  windowEnd: string;
  stepMinutes: number;
  minutes: ColaMinute[];
  candidatesScreened: number;
  sampleSize: number;
  propagations: number;
  computeMs: number;
  truncated: boolean;
  summary: ColaSummary;
  assumptions: ColaAssumptions;
}

export interface ColaOptions {
  /** Spacing between screened liftoff times (integer minutes, default 1). */
  stepMinutes?: number;
  /** Wall-clock budget; the walk stops (truncated = true) when exceeded. */
  timeBudgetMs?: number;
}

/** A catalog object prepared for screening (satrec parsed once). */
export interface ColaCandidate {
  satrec: SatRec;
  name?: string;
  noradId?: string;
}

/** Result of screening ONE liftoff time (reference implementation). */
export interface LaunchScreen {
  minMissKm: number | null;
  /** Index into the candidates array; -1 when nothing was screened. */
  candidateIndex: number;
  /** Closest approach, seconds after insertion. */
  tcaOffsetS: number | null;
  tca: Date | null;
  /** SGP4 + two-body propagations performed. */
  propagations: number;
}

export interface InsertionGeometry {
  direction: AscentDirection;
  /** RAAN of the plane through the site at liftoff (deg, 0-360). */
  raanDeg: number;
  /** Site's argument of latitude in that plane at liftoff (deg). */
  siteArgLatDeg: number;
  /** siteArgLatDeg + DOWNRANGE_DEG, normalized (deg). */
  insertionArgLatDeg: number;
  /** Instant `state` applies to: liftoff + INSERTION_DELAY_S. */
  insertionEpoch: Date;
  /** Circular two-body ECI (TEME-equivalent) state at insertion. */
  state: StateVector;
}

/* ------------------------------------------------------------
   Catalog lookups (Map, never an object literal, so ids such as
   "__proto__" can never resolve through Object.prototype)
   ------------------------------------------------------------ */

const SITE_BY_ID: ReadonlyMap<string, LaunchSite> = new Map(
  LAUNCH_SITES.map((s) => [s.id, s])
);
const ORBIT_BY_ID: ReadonlyMap<string, TargetOrbit> = new Map(
  TARGET_ORBITS.map((o) => [o.id, o])
);

export function findLaunchSite(id: string): LaunchSite | null {
  return SITE_BY_ID.get(id) ?? null;
}

export function findTargetOrbit(id: string): TargetOrbit | null {
  return ORBIT_BY_ID.get(id) ?? null;
}

/* ------------------------------------------------------------
   Geometry
   ------------------------------------------------------------ */

/**
 * Which half of the orbit plane the ascent flies: SOUTHBOUND for
 * sites that only launch south (SLC-4E) and for retrograde orbits
 * (i > 90°, e.g. SSO via the polar corridor); NORTHBOUND otherwise.
 */
export function ascentDirection(site: LaunchSite, orbit: TargetOrbit): AscentDirection {
  return site.southboundOnly === true || orbit.inclinationDeg > 90
    ? "SOUTHBOUND"
    : "NORTHBOUND";
}

/**
 * Full insertion geometry for a liftoff at `launchTime`, or null when
 * no plane of the requested inclination passes through the site
 * (|latitude| above the inclination) or an input is not finite.
 */
export function insertionGeometry(
  site: LaunchSite,
  orbit: TargetOrbit,
  launchTime: Date
): InsertionGeometry | null {
  const t = launchTime.getTime();
  if (!Number.isFinite(t)) return null;
  if (
    !Number.isFinite(orbit.altitudeKm) ||
    !Number.isFinite(orbit.inclinationDeg) ||
    !Number.isFinite(site.latitudeDeg) ||
    !Number.isFinite(site.longitudeDeg) ||
    !Number.isFinite(site.heightKm)
  ) {
    return null;
  }

  const r = siteEci(site, launchTime);
  const ascending = raanThroughPosition(r, orbit.inclinationDeg);
  if (ascending === null) return null;

  // The other plane through the site: sin(Ω − α) = s has the second
  // root Ω' = 2α + 180° − Ω (α = the site's right ascension).
  const alphaDeg = radToDeg(Math.atan2(r[1], r[0]));
  const mirrored = normalizeDeg360(2 * alphaDeg + 180 - ascending);

  // Pick the root whose motion at the site matches the ascent
  // direction. In circularOrbitState's convention vz ∝ cos(u)·sin(i)
  // with sin(i) > 0, so northbound ⇔ cos(u) ≥ 0. Checking both roots
  // (instead of trusting which one is "ascending") keeps this right
  // for prograde and retrograde inclinations alike.
  const wantNorth = ascentDirection(site, orbit) === "NORTHBOUND";
  let raanDeg = ascending;
  let siteArgLatDeg = argumentOfLatitude(r, orbit.inclinationDeg, ascending);
  if ((Math.cos(degToRad(siteArgLatDeg)) >= 0) !== wantNorth) {
    raanDeg = mirrored;
    siteArgLatDeg = argumentOfLatitude(r, orbit.inclinationDeg, mirrored);
  }

  const insertionArgLatDeg = normalizeDeg360(siteArgLatDeg + DOWNRANGE_DEG);
  const state = circularOrbitState({
    altitudeKm: orbit.altitudeKm,
    inclinationDeg: orbit.inclinationDeg,
    raanDeg,
    argLatDeg: insertionArgLatDeg,
  });
  if (!state.position.every(Number.isFinite) || !state.velocity.every(Number.isFinite)) {
    return null;
  }

  return {
    direction: wantNorth ? "NORTHBOUND" : "SOUTHBOUND",
    raanDeg,
    siteArgLatDeg,
    insertionArgLatDeg,
    insertionEpoch: new Date(t + INSERTION_DELAY_S * 1000),
    state,
  };
}

/**
 * Vehicle state at insertion (liftoff + INSERTION_DELAY_S) for a
 * liftoff at `launchTime`; null when the inclination is below the
 * site latitude (no direct-ascent plane through the site).
 */
export function insertionState(
  site: LaunchSite,
  orbit: TargetOrbit,
  launchTime: Date
): StateVector | null {
  return insertionGeometry(site, orbit, launchTime)?.state ?? null;
}

/** Fixed reference instant — a site's declination does not depend on time. */
const REACHABILITY_REFERENCE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/**
 * Whether a direct ascent from `site` can reach `orbit`'s inclination
 * (time-independent: the site's geocentric latitude is fixed).
 */
export function orbitReachable(site: LaunchSite, orbit: TargetOrbit): boolean {
  return insertionGeometry(site, orbit, REACHABILITY_REFERENCE) !== null;
}

/* ------------------------------------------------------------
   Grading + summary
   ------------------------------------------------------------ */

export function colaStatus(minMissKm: number | null): ColaStatus {
  if (minMissKm === null || !Number.isFinite(minMissKm)) return "GO";
  if (minMissKm < COLA_RED_KM) return "NO-GO";
  if (minMissKm < COLA_YELLOW_KM) return "CAUTION";
  return "GO";
}

/**
 * Status counts + the first run of consecutive GO minutes, scanning
 * from the first screened minute. The run length is reported in
 * minutes (run count × stepMinutes).
 */
export function summarizeColaMinutes(
  minutes: readonly ColaMinute[],
  stepMinutes: number
): ColaSummary {
  let go = 0;
  let caution = 0;
  let noGo = 0;
  for (const m of minutes) {
    if (m.status === "GO") go++;
    else if (m.status === "CAUTION") caution++;
    else noGo++;
  }

  let nextClearWindow: ColaSummary["nextClearWindow"] = null;
  const first = minutes.findIndex((m) => m.status === "GO");
  if (first >= 0) {
    let run = 0;
    for (let i = first; i < minutes.length && minutes[i].status === "GO"; i++) run++;
    nextClearWindow = { start: minutes[first].launchTime, minutes: run * stepMinutes };
  }

  return { go, caution, noGo, nextClearWindow };
}

export function colaAssumptions(): ColaAssumptions {
  return {
    insertionDelayS: INSERTION_DELAY_S,
    downrangeDeg: DOWNRANGE_DEG,
    screenAfterInsertionS: SCREEN_AFTER_INSERTION_S,
    screenStepS: SCREEN_STEP_S,
    altBandKm: ALT_BAND_KM,
    redKm: COLA_RED_KM,
    yellowKm: COLA_YELLOW_KM,
  };
}

/* ------------------------------------------------------------
   Candidate prefilter
   ------------------------------------------------------------ */

function isTleRow(v: unknown): v is SpaceTrackTLE {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.TLE_LINE1 === "string" && typeof o.TLE_LINE2 === "string";
}

function cleanString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Objects whose altitude range overlaps [alt − band, alt + band],
 * with their satrec parsed once. Uses the gp APOAPSIS / PERIAPSIS
 * strings; falls back to the TLE-derived apsides when those strings
 * are missing or not numeric. Unparseable TLEs are skipped.
 */
export function selectColaCandidates(
  orbit: TargetOrbit,
  sample: readonly unknown[],
  altBandKm: number = ALT_BAND_KM
): ColaCandidate[] {
  const lo = orbit.altitudeKm - altBandKm;
  const hi = orbit.altitudeKm + altBandKm;
  const out: ColaCandidate[] = [];
  if (!Array.isArray(sample)) return out;

  for (const row of sample) {
    if (!isTleRow(row)) continue;
    let satrec: SatRec | null = null;
    let peri = parseFloat(row.PERIAPSIS);
    let apo = parseFloat(row.APOAPSIS);
    if (!Number.isFinite(peri) || !Number.isFinite(apo)) {
      satrec = parseTle(row.TLE_LINE1, row.TLE_LINE2);
      if (!satrec) continue;
      const el = tleElements(row, satrec);
      if (!el) continue;
      peri = el.perigeeKm;
      apo = el.apogeeKm;
    }
    const pMin = Math.min(peri, apo);
    const pMax = Math.max(peri, apo);
    if (!(pMin <= hi && pMax >= lo)) continue;

    if (!satrec) satrec = parseTle(row.TLE_LINE1, row.TLE_LINE2);
    if (!satrec) continue;

    const noradId = cleanString(row.NORAD_CAT_ID) || satrec.satnum.trim();
    const name = cleanString(row.OBJECT_NAME) || `NORAD ${noradId}`;
    out.push({ satrec, name, noradId });
  }
  return out;
}

/* ------------------------------------------------------------
   Distance core
   ------------------------------------------------------------ */

/**
 * Closest approach within one sampling cell under straight-line
 * relative motion: Δr(t) = Δr + Δv·t for t ∈ [tLo, tHi] (s).
 * Writes the squared miss (km²) to out[0] and t* (s) to out[1].
 * NaN inputs (failed propagation) yield NaN, which every caller's
 * `d2 < best` comparison rejects.
 */
function closestInCell(
  out: Float64Array,
  dx: number,
  dy: number,
  dz: number,
  dvx: number,
  dvy: number,
  dvz: number,
  tLo: number,
  tHi: number
): void {
  const rr = dx * dx + dy * dy + dz * dz;
  const rv = dx * dvx + dy * dvy + dz * dvz;
  const vv = dvx * dvx + dvy * dvy + dvz * dvz;
  let t = vv > 0 ? -rv / vv : 0;
  if (t < tLo) t = tLo;
  else if (t > tHi) t = tHi;
  const d2 = rr + 2 * t * rv + t * t * vv;
  // Rounding can push an exact hit a hair below zero; NaN passes through.
  out[0] = d2 < 0 ? 0 : d2;
  out[1] = t;
}

function roundKm(km: number): number {
  return Math.round(km * 1000) / 1000;
}

function nowMs(): number {
  const p = globalThis.performance;
  return p && typeof p.now === "function" ? p.now() : Date.now();
}

/** Number of coast samples after insertion (k = 0 … COAST_STEPS). */
const COAST_STEPS = Math.round(SCREEN_AFTER_INSERTION_S / SCREEN_STEP_S);
const HALF_STEP_S = SCREEN_STEP_S / 2;

/**
 * Reference implementation: screen ONE liftoff. `insertion` is the
 * vehicle state at `insertionEpoch`; every candidate is propagated
 * with SGP4 at every coast sample (no caching). Used directly by the
 * node tests and as the fallback when the shared-grid fast path does
 * not apply.
 */
export function screenOneLaunch(
  insertion: StateVector,
  insertionEpoch: Date,
  candidates: readonly ColaCandidate[]
): LaunchScreen {
  const epochMs = insertionEpoch.getTime();
  const scratch = new Float64Array(2);
  let best = Infinity;
  let bestC = -1;
  let bestT = 0;
  let propagations = 0;

  if (Number.isFinite(epochMs) && candidates.length > 0) {
    for (let k = 0; k <= COAST_STEPS; k++) {
      const offsetS = k * SCREEN_STEP_S;
      const veh = k === 0 ? insertion : twoBodyPropagate(insertion, offsetS);
      if (k > 0) propagations++;
      if (!veh) continue;
      const tLo = k === 0 ? 0 : -HALF_STEP_S;
      const tHi = k === COAST_STEPS ? 0 : HALF_STEP_S;
      const when = new Date(epochMs + offsetS * 1000);
      const [vx, vy, vz] = veh.position;
      const [wx, wy, wz] = veh.velocity;
      for (let c = 0; c < candidates.length; c++) {
        const sv = propagateMinutes(candidates[c].satrec, minutesSinceEpoch(candidates[c].satrec, when));
        propagations++;
        if (!sv) continue;
        closestInCell(
          scratch,
          sv.position[0] - vx,
          sv.position[1] - vy,
          sv.position[2] - vz,
          sv.velocity[0] - wx,
          sv.velocity[1] - wy,
          sv.velocity[2] - wz,
          tLo,
          tHi
        );
        if (scratch[0] < best) {
          best = scratch[0];
          bestC = c;
          bestT = offsetS + scratch[1];
        }
      }
    }
  }

  if (bestC < 0 || !Number.isFinite(best)) {
    return { minMissKm: null, candidateIndex: -1, tcaOffsetS: null, tca: null, propagations };
  }
  return {
    minMissKm: Math.sqrt(best),
    candidateIndex: bestC,
    tcaOffsetS: bestT,
    tca: new Date(epochMs + bestT * 1000),
    propagations,
  };
}

function toColaMinute(
  launchMs: number,
  screen: LaunchScreen,
  candidates: readonly ColaCandidate[]
): ColaMinute {
  const c = screen.candidateIndex >= 0 ? candidates[screen.candidateIndex] : undefined;
  const miss = screen.minMissKm !== null && Number.isFinite(screen.minMissKm)
    ? roundKm(screen.minMissKm)
    : null;
  const tcaMs = screen.tca ? screen.tca.getTime() : NaN;
  return {
    launchTime: new Date(launchMs).toISOString(),
    status: colaStatus(miss),
    minMissKm: miss,
    objectName: c ? c.name ?? `NORAD ${c.satrec.satnum.trim()}` : null,
    noradId: c ? c.noradId ?? c.satrec.satnum.trim() : null,
    tca: c && Number.isFinite(tcaMs) ? new Date(Math.round(tcaMs)).toISOString() : null,
  };
}

/* ------------------------------------------------------------
   Window screen (shared-grid fast path)
   ------------------------------------------------------------ */

/**
 * Screen every liftoff time in [windowStart, windowStart + windowMinutes)
 * at `stepMinutes` spacing. Throws RangeError for invalid arguments or an
 * unreachable site/orbit pair (validate with orbitReachable first).
 */
export function screenLaunchWindow(
  site: LaunchSite,
  orbit: TargetOrbit,
  sample: readonly SpaceTrackTLE[],
  windowStart: Date,
  windowMinutes: number,
  options: ColaOptions = {}
): ColaResult {
  const t0 = nowMs();
  const stepMinutes = options.stepMinutes ?? DEFAULT_COLA_OPTIONS.stepMinutes;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_COLA_OPTIONS.timeBudgetMs;

  const startMs = windowStart.getTime();
  if (!Number.isFinite(startMs)) throw new RangeError("windowStart is not a valid date.");
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || windowMinutes > COLA_MAX_WINDOW_MINUTES) {
    throw new RangeError(`windowMinutes must be in (0, ${COLA_MAX_WINDOW_MINUTES}].`);
  }
  if (!Number.isInteger(stepMinutes) || stepMinutes < 1 || stepMinutes > COLA_MAX_STEP_MINUTES) {
    throw new RangeError(`stepMinutes must be an integer in [1, ${COLA_MAX_STEP_MINUTES}].`);
  }
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) {
    throw new RangeError("timeBudgetMs must be a positive number.");
  }

  const firstGeometry = insertionGeometry(site, orbit, windowStart);
  if (!firstGeometry) {
    throw new RangeError(
      `${orbit.label} (inclination ${orbit.inclinationDeg}°) cannot be reached by a direct ascent from ${site.label} (latitude ${site.latitudeDeg}°).`
    );
  }

  const rows: readonly unknown[] = Array.isArray(sample) ? sample : [];
  const candidates = selectColaCandidates(orbit, rows);
  const C = candidates.length;
  const launchCount = Math.max(1, Math.floor(windowMinutes / stepMinutes));
  const stepMs = stepMinutes * 60_000;

  // Shared 30 s grid (see header): stride = grid points between liftoffs.
  const stride = (stepMinutes * 60) / SCREEN_STEP_S;
  const sharedGrid = Number.isInteger(stride);
  const STEPS = COAST_STEPS + 1;
  const gridStepMin = SCREEN_STEP_S / 60;
  const gridOrigin = new Date(startMs + INSERTION_DELAY_S * 1000);

  // Per-candidate minutes-since-epoch at grid index 0, so a grid point
  // costs exactly one SGP4 call: t_j = base[c] + j · gridStepMin.
  const base = new Float64Array(C);
  for (let c = 0; c < C; c++) base[c] = minutesSinceEpoch(candidates[c].satrec, gridOrigin);

  // Ring of STEPS slots × (x, y, z, vx, vy, vz) per candidate. Any STEPS
  // consecutive grid indices map to distinct slots (j mod STEPS).
  const slots: Float64Array[] = [];
  const slotGrid = new Float64Array(STEPS).fill(-1);
  if (sharedGrid && C > 0) {
    for (let s = 0; s < STEPS; s++) slots.push(new Float64Array(6 * C));
  }

  const scratch = new Float64Array(2);
  const minutes: ColaMinute[] = [];
  let propagations = 0;
  let truncated = false;

  for (let m = 0; m < launchCount; m++) {
    if (m > 0 && nowMs() - t0 > timeBudgetMs) {
      truncated = true;
      break;
    }
    const launchMs = startMs + m * stepMs;
    const geometry = m === 0 ? firstGeometry : insertionGeometry(site, orbit, new Date(launchMs));
    if (!geometry) {
      // Unreachable is time-independent, so this cannot happen after the
      // first minute succeeded; guard anyway rather than crash.
      minutes.push(toColaMinute(launchMs, emptyScreen(), candidates));
      continue;
    }

    if (!sharedGrid) {
      const ref = screenOneLaunch(geometry.state, geometry.insertionEpoch, candidates);
      propagations += ref.propagations;
      minutes.push(toColaMinute(launchMs, ref, candidates));
      continue;
    }

    let best = Infinity;
    let bestC = -1;
    let bestT = 0;
    if (C > 0) {
      for (let k = 0; k <= COAST_STEPS; k++) {
        const offsetS = k * SCREEN_STEP_S;
        const veh = k === 0 ? geometry.state : twoBodyPropagate(geometry.state, offsetS);
        if (k > 0) propagations++;
        if (!veh) continue;

        const j = m * stride + k;
        const s = j % STEPS;
        const slot = slots[s];
        if (slotGrid[s] !== j) {
          const tOffsetMin = j * gridStepMin;
          for (let c = 0; c < C; c++) {
            const sv = propagateMinutes(candidates[c].satrec, base[c] + tOffsetMin);
            const o = c * 6;
            if (sv) {
              slot[o] = sv.position[0];
              slot[o + 1] = sv.position[1];
              slot[o + 2] = sv.position[2];
              slot[o + 3] = sv.velocity[0];
              slot[o + 4] = sv.velocity[1];
              slot[o + 5] = sv.velocity[2];
            } else {
              slot[o] = NaN;
              slot[o + 1] = NaN;
              slot[o + 2] = NaN;
              slot[o + 3] = NaN;
              slot[o + 4] = NaN;
              slot[o + 5] = NaN;
            }
          }
          propagations += C;
          slotGrid[s] = j;
        }

        const tLo = k === 0 ? 0 : -HALF_STEP_S;
        const tHi = k === COAST_STEPS ? 0 : HALF_STEP_S;
        const vx = veh.position[0];
        const vy = veh.position[1];
        const vz = veh.position[2];
        const wx = veh.velocity[0];
        const wy = veh.velocity[1];
        const wz = veh.velocity[2];
        for (let c = 0, o = 0; c < C; c++, o += 6) {
          closestInCell(
            scratch,
            slot[o] - vx,
            slot[o + 1] - vy,
            slot[o + 2] - vz,
            slot[o + 3] - wx,
            slot[o + 4] - wy,
            slot[o + 5] - wz,
            tLo,
            tHi
          );
          if (scratch[0] < best) {
            best = scratch[0];
            bestC = c;
            bestT = offsetS + scratch[1];
          }
        }
      }
    }

    const epochMs = geometry.insertionEpoch.getTime();
    const screen: LaunchScreen =
      bestC >= 0 && Number.isFinite(best)
        ? {
            minMissKm: Math.sqrt(best),
            candidateIndex: bestC,
            tcaOffsetS: bestT,
            tca: new Date(epochMs + bestT * 1000),
            propagations: 0,
          }
        : emptyScreen();
    minutes.push(toColaMinute(launchMs, screen, candidates));
  }

  return {
    site,
    orbit,
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(startMs + windowMinutes * 60_000).toISOString(),
    stepMinutes,
    minutes,
    candidatesScreened: C,
    sampleSize: rows.length,
    propagations,
    computeMs: Math.round(nowMs() - t0),
    truncated,
    summary: summarizeColaMinutes(minutes, stepMinutes),
    assumptions: colaAssumptions(),
  };
}

function emptyScreen(): LaunchScreen {
  return { minMissKm: null, candidateIndex: -1, tcaOffsetS: null, tca: null, propagations: 0 };
}
