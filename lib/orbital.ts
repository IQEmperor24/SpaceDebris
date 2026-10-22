import * as satellite from "satellite.js";
import type { SatRec } from "satellite.js";
import type { SpaceTrackTLE } from "@/lib/spacetrack";

/* ============================================================
   SpaceDebris — shared deterministic orbital-mechanics helpers

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic.
   Everything here is plain math on top of satellite.js (SGP4),
   so it runs identically in the browser (OrbitalMap, ISS
   console, density profile, fragmentation tracker, reentry
   watch, mission clock) and on the Node runtime (conjunction
   screening route).

   Conventions
   - Distances in km, velocities in km/s.
   - Angles are DEGREES at this module's public boundary;
     satellite.js works in radians internally.
   - "ECI" is the TEME frame SGP4 natively produces.
   - Point altitude = geocentric radius − EARTH_RADIUS_KM (mean
     radius, 6371 km) to match OrbitalMap.tsx exactly.
   - Apogee / perigee use the EQUATORIAL radius (6378.137 km),
     the convention Space-Track's gp class uses, so values here
     line up with APOAPSIS / PERIAPSIS to within a few hundred m.

   satellite.js 5.0.0 quirks handled here (do not "simplify"):
   - sgp4() returns `[false, false]` (an ARRAY) on eccentricity /
     mean-motion errors and `{ position: false }` on decay, so a
     result must be checked with `typeof pv.position === "object"`.
   - satrec.ndot is the RAW TLE field (ṅ/2 in rev/day²) — the
     unit conversion in io.js is commented out upstream. We parse
     the field straight from TLE line 1 instead of relying on it.
   ============================================================ */

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/** Mean Earth radius — matches OrbitalMap.tsx (point altitudes). */
export const EARTH_RADIUS_KM = 6371.0;
/** Equatorial Earth radius — used for apogee / perigee heights. */
export const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;
/** Standard gravitational parameter of Earth (km³/s²). */
export const MU_EARTH_KM3_S2 = 398600.4418;
export const SECONDS_PER_DAY = 86_400;
export const MINUTES_PER_DAY = 1_440;
export const MS_PER_DAY = 86_400_000;
/** Julian Date of the Unix epoch (1970-01-01T00:00:00Z). */
export const JD_UNIX_EPOCH = 2_440_587.5;
/** Altitude below which an object is treated as re-entered (km). */
export const REENTRY_ALTITUDE_KM = 120;

/** International Space Station — NORAD catalog number. */
export const ISS_NORAD_ID = "25544";

/** NASA Johnson Space Center, Houston TX (Building 30 / MCC area). */
export const JSC_SITE = {
  name: "NASA Johnson Space Center",
  shortName: "JSC HOUSTON",
  latitudeDeg: 29.5593,
  longitudeDeg: -95.09,
  heightKm: 0.016,
} as const;

/**
 * NASA ISS conjunction-assessment thresholds (public TOPO / CARA
 * practice): Pc ≥ 1e-4 is the RED threshold where a Debris
 * Avoidance Maneuver (DAM / PDAM) is planned if mission constraints
 * allow; 1e-5 ≤ Pc < 1e-4 is YELLOW (heightened monitoring).
 */
export const ISS_PC_RED_THRESHOLD = 1e-4;
export const ISS_PC_YELLOW_THRESHOLD = 1e-5;

/**
 * SpaceX Starlink autonomous collision-avoidance trigger: the
 * constellation maneuvers when Pc exceeds 3e-7 — more than 300× below
 * the industry-standard 1e-4 (SpaceX semiannual Starlink report to the
 * FCC, 1 July 2026, covering Dec 2025 – May 2026). Earlier filings
 * (2022-23) cited 1e-5; the trigger has only ever been tightened.
 */
export const STARLINK_PC_MANEUVER_THRESHOLD = 3e-7;

/**
 * NASA ISS screening "pizza box" keep-out volume, half-widths in km
 * (radial × in-track × cross-track). Any predicted penetration of
 * this box triggers detailed CA analysis.
 */
export const ISS_KEEP_OUT_BOX_KM = {
  radial: 2,
  inTrack: 25,
  crossTrack: 25,
} as const;

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

export type Vec3 = [number, number, number];

/** ECI (TEME) state vector — km and km/s. */
export interface StateVector {
  position: Vec3;
  velocity: Vec3;
}

export interface GeodeticPoint {
  latitudeDeg: number;
  longitudeDeg: number; // normalized to [-180, 180]
  altitudeKm: number; // height above the WGS-84 ellipsoid (satellite.js eciToGeodetic)
}

/** Radial / In-track / Cross-track unit vectors (ECI components). */
export interface RicFrame {
  radial: Vec3;
  inTrack: Vec3;
  crossTrack: Vec3;
}

export interface RicVector {
  radialKm: number;
  inTrackKm: number;
  crossTrackKm: number;
}

export interface LookAngles {
  azimuthDeg: number; // 0-360, clockwise from north
  elevationDeg: number; // -90..90
  rangeKm: number;
}

export interface ObserverSite {
  latitudeDeg: number;
  longitudeDeg: number;
  heightKm: number;
}

/** Human-readable orbital elements derived from a TLE. */
export interface TleElements {
  noradId: string;
  name: string;
  epoch: Date;
  inclinationDeg: number;
  eccentricity: number;
  raanDeg: number;
  argPerigeeDeg: number;
  meanMotionRevPerDay: number;
  periodMinutes: number;
  semiMajorAxisKm: number;
  apogeeKm: number;
  perigeeKm: number;
  /** TLE line-1 field: first derivative of mean motion / 2 (rev/day²). */
  ndotHalfRevPerDay2: number;
  /** B* drag term (1 / Earth radii). */
  bstar: number;
}

/** First-order orbital-decay estimate from TLE drag terms. */
export interface DecayEstimate {
  perigeeKm: number;
  apogeeKm: number;
  semiMajorAxisKm: number;
  meanAltitudeKm: number;
  ndotHalfRevPerDay2: number;
  bstar: number;
  /** Positive = orbit is shrinking (km of semi-major axis per day). */
  decayKmPerDay: number;
  /**
   * Days until the mean altitude reaches REENTRY_ALTITUDE_KM at the
   * CURRENT decay rate. Real decay accelerates as drag grows, so this
   * is an optimistic (upper-bound) figure. null when not decaying.
   */
  estimatedLifetimeDays: number | null;
}

export type OrbitalShell = "LEO" | "MEO" | "GEO";

/* ------------------------------------------------------------
   Vector helpers
   ------------------------------------------------------------ */

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vNorm(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

/** Unit vector; returns [0,0,0] for a zero-length input. */
export function vUnit(a: Vec3): Vec3 {
  const n = vNorm(a);
  if (!Number.isFinite(n) || n === 0) return [0, 0, 0];
  return [a[0] / n, a[1] / n, a[2] / n];
}

/* ------------------------------------------------------------
   Time
   ------------------------------------------------------------ */

/** Julian Date (UTC-based, as satellite.js uses) for a JS Date. */
export function dateToJulian(date: Date): number {
  return date.getTime() / MS_PER_DAY + JD_UNIX_EPOCH;
}

export function julianToDate(jd: number): Date {
  return new Date((jd - JD_UNIX_EPOCH) * MS_PER_DAY);
}

/** Greenwich Mean Sidereal Time in radians (0..2π). */
export function gmstRadians(date: Date): number {
  return satellite.gstime(date);
}

/** Greenwich Mean Sidereal Time in hours (0..24). */
export function gmstHours(date: Date): number {
  let hours = ((gmstRadians(date) * 12) / Math.PI) % 24;
  if (hours < 0) hours += 24;
  return hours;
}

/** Day of year 1..366 (UTC). */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / MS_PER_DAY) + 1;
}

/** Format decimal hours as HH:MM:SS. */
export function formatHoursHms(hours: number): string {
  let total = Math.floor(((hours % 24) + 24) % 24 * 3600);
  const h = Math.floor(total / 3600);
  total -= h * 3600;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** Format a Date as "YYYY-MM-DD HH:MM:SS" in UTC. */
export function formatUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(
    date.getUTCDate()
  )} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds()
  )}`;
}

/** Format a Date as "HH:MM:SS" in UTC. */
export function formatUtcTime(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(
    date.getUTCSeconds()
  )}`;
}

/** Human-readable duration: "2h 14m", "45m 10s", "3d 4h". */
export function formatDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${sign}${d}d ${h}h`;
  if (h > 0) return `${sign}${h}h ${pad2(m)}m`;
  if (m > 0) return `${sign}${m}m ${pad2(s)}s`;
  return `${sign}${s}s`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/* ------------------------------------------------------------
   TLE parsing
   ------------------------------------------------------------ */

/**
 * Parse a TLE into a satellite.js SatRec.
 * Returns null for malformed lines or an initialization error so
 * callers can skip bad catalog rows without try/catch everywhere.
 */
export function parseTle(line1: string, line2: string): SatRec | null {
  if (typeof line1 !== "string" || typeof line2 !== "string") return null;
  if (line1.length < 62 || line2.length < 63) return null;
  try {
    const satrec = satellite.twoline2satrec(line1, line2);
    if (!satrec || satrec.error !== 0) return null;
    if (!Number.isFinite(satrec.no) || satrec.no <= 0) return null;
    if (!Number.isFinite(satrec.jdsatepoch)) return null;
    return satrec;
  } catch {
    return null;
  }
}

/** Epoch of the element set as a JS Date. */
export function tleEpochDate(satrec: SatRec): Date {
  return julianToDate(satrec.jdsatepoch);
}

/** Minutes between a TLE epoch and a Date (negative = before epoch). */
export function minutesSinceEpoch(satrec: SatRec, date: Date): number {
  return (dateToJulian(date) - satrec.jdsatepoch) * MINUTES_PER_DAY;
}

/**
 * Derive human-readable elements from a Space-Track TLE row.
 * Uses the TLE lines (not the gp string fields); mean motion is the
 * TLE's Kozai value so the derived period / apsides match the
 * catalog's PERIOD / APOAPSIS / PERIAPSIS to within a few hundred m.
 */
export function tleElements(
  tle: Pick<SpaceTrackTLE, "TLE_LINE1" | "TLE_LINE2"> &
    Partial<Pick<SpaceTrackTLE, "NORAD_CAT_ID" | "OBJECT_NAME">>,
  satrecIn?: SatRec | null
): TleElements | null {
  const satrec = satrecIn ?? parseTle(tle.TLE_LINE1, tle.TLE_LINE2);
  if (!satrec) return null;

  // Human-readable elements use the TLE's own (Kozai) mean motion from
  // line 2 cols 53-63 so period / SMA / apogee / perigee line up with
  // Space-Track's MEAN_MOTION / PERIOD / APOAPSIS / PERIAPSIS. (sgp4init
  // overwrites satrec.no with the un-Kozai'd Brouwer value, which is
  // right for propagation but ~0.1 % off for display.)
  const nKozai = parseFloat(tle.TLE_LINE2.substring(52, 63));
  const meanMotionRevPerDay =
    Number.isFinite(nKozai) && nKozai > 0
      ? nKozai
      : (satrec.no * MINUTES_PER_DAY) / (2 * Math.PI);
  const periodMinutes = MINUTES_PER_DAY / meanMotionRevPerDay;
  const nRadPerSec = (meanMotionRevPerDay * 2 * Math.PI) / SECONDS_PER_DAY;
  const semiMajorAxisKm = Math.cbrt(MU_EARTH_KM3_S2 / (nRadPerSec * nRadPerSec));
  const e = satrec.ecco;

  // TLE line 1, columns 34-43: first derivative of mean motion / 2.
  const ndotField = parseFloat(tle.TLE_LINE1.substring(33, 43));

  return {
    noradId: tle.NORAD_CAT_ID ?? satrec.satnum.trim(),
    name: tle.OBJECT_NAME ?? `NORAD ${satrec.satnum.trim()}`,
    epoch: tleEpochDate(satrec),
    inclinationDeg: radToDeg(satrec.inclo),
    eccentricity: e,
    raanDeg: normalizeDeg360(radToDeg(satrec.nodeo)),
    argPerigeeDeg: normalizeDeg360(radToDeg(satrec.argpo)),
    meanMotionRevPerDay,
    periodMinutes,
    semiMajorAxisKm,
    apogeeKm: semiMajorAxisKm * (1 + e) - EARTH_EQUATORIAL_RADIUS_KM,
    perigeeKm: semiMajorAxisKm * (1 - e) - EARTH_EQUATORIAL_RADIUS_KM,
    ndotHalfRevPerDay2: Number.isFinite(ndotField) ? ndotField : 0,
    bstar: Number.isFinite(satrec.bstar) ? satrec.bstar : 0,
  };
}

/* ------------------------------------------------------------
   Propagation
   ------------------------------------------------------------ */

/**
 * Propagate to `minutes` after the TLE epoch. Fast path (no Date
 * conversion) — use this in tight loops (screening, map ticks).
 * Returns null on any SGP4 error, including the upstream
 * "[false, false]" array return.
 */
export function propagateMinutes(
  satrec: SatRec,
  minutes: number
): StateVector | null {
  if (!Number.isFinite(minutes)) return null;
  let pv: satellite.PositionAndVelocity;
  try {
    pv = satellite.sgp4(satrec, minutes);
  } catch {
    return null;
  }
  if (!pv || typeof pv !== "object") return null;
  const p = (pv as { position?: unknown }).position;
  const v = (pv as { velocity?: unknown }).velocity;
  if (!isVecLike(p) || !isVecLike(v)) return null;
  const position: Vec3 = [p.x, p.y, p.z];
  const velocity: Vec3 = [v.x, v.y, v.z];
  if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite)) {
    return null;
  }
  return { position, velocity };
}

/** Propagate to an absolute Date. */
export function propagateAt(satrec: SatRec, date: Date): StateVector | null {
  return propagateMinutes(satrec, minutesSinceEpoch(satrec, date));
}

function isVecLike(v: unknown): v is { x: number; y: number; z: number } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.z === "number"
  );
}

/** Geocentric altitude of an ECI position (mean-radius convention). */
export function altitudeKmFromEci(position: Vec3): number {
  return vNorm(position) - EARTH_RADIUS_KM;
}

export function speedKmS(velocity: Vec3): number {
  return vNorm(velocity);
}

/** ECI → ECF (Earth-fixed) rotation for the given GMST (radians). */
export function eciToEcf(position: Vec3, gmst: number): Vec3 {
  const ecf = satellite.eciToEcf(
    { x: position[0], y: position[1], z: position[2] },
    gmst
  );
  return [ecf.x, ecf.y, ecf.z];
}

/** Sub-satellite point (geodetic lat/lon/height) for an ECI position. */
export function geodeticFromEci(position: Vec3, date: Date): GeodeticPoint {
  const gmst = gmstRadians(date);
  const gd = satellite.eciToGeodetic(
    { x: position[0], y: position[1], z: position[2] },
    gmst
  );
  return {
    latitudeDeg: satellite.degreesLat(gd.latitude),
    longitudeDeg: normalizeDeg180(satellite.degreesLong(gd.longitude)),
    altitudeKm: gd.height,
  };
}

/**
 * Azimuth / elevation / range of an ECI position as seen from a
 * ground site at the given instant.
 */
export function lookAngles(
  site: ObserverSite,
  positionEci: Vec3,
  date: Date
): LookAngles {
  const gmst = gmstRadians(date);
  const ecf = satellite.eciToEcf(
    { x: positionEci[0], y: positionEci[1], z: positionEci[2] },
    gmst
  );
  const observer: satellite.GeodeticLocation = {
    latitude: satellite.degreesToRadians(site.latitudeDeg),
    longitude: satellite.degreesToRadians(site.longitudeDeg),
    height: site.heightKm,
  };
  const la = satellite.ecfToLookAngles(observer, ecf);
  return {
    azimuthDeg: normalizeDeg360(radToDeg(la.azimuth)),
    elevationDeg: radToDeg(la.elevation),
    rangeKm: la.rangeSat,
  };
}

/* ------------------------------------------------------------
   Frames
   ------------------------------------------------------------ */

/**
 * RIC (a.k.a. RSW / LVLH-style) frame of an object:
 *   radial     = r̂ (outward)
 *   crossTrack = unit(r × v) (orbit normal)
 *   inTrack    = crossTrack × radial (≈ velocity direction)
 */
export function ricFrame(position: Vec3, velocity: Vec3): RicFrame {
  const radial = vUnit(position);
  const crossTrack = vUnit(vCross(position, velocity));
  const inTrack = vCross(crossTrack, radial);
  return { radial, inTrack, crossTrack };
}

/** Express an ECI vector in a RIC frame. */
export function toRic(vec: Vec3, frame: RicFrame): RicVector {
  return {
    radialKm: vDot(vec, frame.radial),
    inTrackKm: vDot(vec, frame.inTrack),
    crossTrackKm: vDot(vec, frame.crossTrack),
  };
}

/* ------------------------------------------------------------
   Space-Track catalog helpers
   ------------------------------------------------------------ */

/**
 * Miss distance of a Space-Track cdm_public row in KILOMETRES.
 *
 * MIN_RNG is in METRES (the CCSDS CDM MISS_DISTANCE convention): a
 * public CDM with PC ≈ 1e-4 carries MIN_RNG ≈ 400, i.e. 400 m — a
 * 400 km miss could never have that probability. Every consumer that
 * wants km (alert feed, fleet thresholds, ISS console, prompts) MUST
 * convert through this helper so the unit lives in exactly one place.
 * Returns null when the field is missing or not a finite number.
 */
export function cdmMissDistanceKm(
  minRng: string | number | null | undefined
): number | null {
  if (minRng === null || minRng === undefined) return null;
  const metres = typeof minRng === "number" ? minRng : parseFloat(minRng);
  if (!Number.isFinite(metres) || metres < 0) return null;
  return metres / 1000;
}

/** "0.388" style km string for display / prompt use; raw field if unparseable. */
export function formatCdmMissKm(minRng: string | number | null | undefined): string {
  const km = cdmMissDistanceKm(minRng);
  if (km === null) return minRng === null || minRng === undefined ? "n/a" : String(minRng);
  return km.toFixed(3);
}

/**
 * Mean altitude (km) from the gp APOAPSIS / PERIAPSIS strings.
 * Same semantics as app/api/fleet + app/api/analyze: NaN if invalid.
 */
export function meanAltitudeKm(
  o: Pick<SpaceTrackTLE, "APOAPSIS" | "PERIAPSIS">
): number {
  const apo = parseFloat(o.APOAPSIS);
  const peri = parseFloat(o.PERIAPSIS);
  if (!Number.isFinite(apo) || !Number.isFinite(peri)) return NaN;
  return (apo + peri) / 2;
}

/** LEO < 2000 km, MEO < 35000 km, GEO otherwise (matches /api/fleet). */
export function classifyShell(altKm: number): OrbitalShell {
  if (altKm < 2000) return "LEO";
  if (altKm < 35000) return "MEO";
  return "GEO";
}

/**
 * Launch designator ("1999-025") from an international designator
 * / OBJECT_ID such as "1999-025DEV". null if the format is unknown.
 */
export function launchDesignator(objectId: string | undefined | null): string | null {
  if (!objectId) return null;
  const m = objectId.trim().match(/^(\d{4}-\d{3})/);
  return m ? m[1] : null;
}

/**
 * Coarse object class from a Space-Track OBJECT_NAME.
 * (" DEB" = fragmentation debris, " R/B" = rocket body.)
 */
export type ObjectClass = "DEBRIS" | "ROCKET BODY" | "PAYLOAD" | "UNKNOWN";

export function classifyObjectName(name: string | undefined | null): ObjectClass {
  if (!name) return "UNKNOWN";
  const n = name.toUpperCase();
  if (/\bDEB\b/.test(n) || n.includes(" DEB")) return "DEBRIS";
  if (n.includes("R/B") || n.includes(" AKM") || n.includes(" PKM")) {
    return "ROCKET BODY";
  }
  if (n.startsWith("TBA") || n.startsWith("UNKNOWN")) return "UNKNOWN";
  return "PAYLOAD";
}

/* ------------------------------------------------------------
   Orbital decay (first-order, from TLE drag terms)
   ------------------------------------------------------------ */

/**
 * First-order decay estimate.
 *   n  = mean motion (rev/day), ṅ = 2 × (TLE ṅ/2 field) (rev/day²)
 *   a  = (μ / n²)^(1/3)
 *   da/dt = −(2/3) · a · (ṅ / n)      →  decayKmPerDay = (2/3)·a·(ṅ/n)
 * Lifetime = (meanAltitude − REENTRY_ALTITUDE_KM) / decayKmPerDay,
 * i.e. assumes the CURRENT rate holds — real decay accelerates, so
 * treat the number as an optimistic upper bound and say so in UI.
 */
export function decayEstimate(el: TleElements): DecayEstimate {
  const n = el.meanMotionRevPerDay;
  const ndot = 2 * el.ndotHalfRevPerDay2;
  const meanAltitudeKm = el.semiMajorAxisKm - EARTH_EQUATORIAL_RADIUS_KM;

  let decayKmPerDay = 0;
  if (Number.isFinite(n) && n > 0 && Number.isFinite(ndot)) {
    decayKmPerDay = (2 / 3) * el.semiMajorAxisKm * (ndot / n);
  }

  let estimatedLifetimeDays: number | null = null;
  if (decayKmPerDay > 1e-6 && meanAltitudeKm > REENTRY_ALTITUDE_KM) {
    estimatedLifetimeDays = (meanAltitudeKm - REENTRY_ALTITUDE_KM) / decayKmPerDay;
  } else if (decayKmPerDay > 1e-6) {
    estimatedLifetimeDays = 0;
  }

  return {
    perigeeKm: el.perigeeKm,
    apogeeKm: el.apogeeKm,
    semiMajorAxisKm: el.semiMajorAxisKm,
    meanAltitudeKm,
    ndotHalfRevPerDay2: el.ndotHalfRevPerDay2,
    bstar: el.bstar,
    decayKmPerDay,
    estimatedLifetimeDays,
  };
}

/* ------------------------------------------------------------
   Probability of collision (2-D encounter-plane integral)
   ------------------------------------------------------------ */

export interface PcObjectState {
  position: Vec3; // ECI km at TCA
  velocity: Vec3; // ECI km/s at TCA
  /** 1-σ position uncertainty in that object's own RIC frame (km). */
  sigmaRicKm: Vec3;
}

export interface PcInput {
  primary: PcObjectState;
  secondary: PcObjectState;
  /** Combined hard-body radius (km). */
  hardBodyRadiusKm: number;
}

/**
 * Probability of collision using the standard short-encounter
 * approximation (Foster / Alfano): combine both objects' position
 * covariances, project onto the encounter plane perpendicular to
 * the relative velocity, and integrate the resulting 2-D Gaussian
 * over the hard-body disk centred on the miss vector.
 *
 * Numerical integration: polar midpoint rule (48 × 96 cells) —
 * converged to better than 1 % for HBR ≪ σ, which is the regime
 * every TLE-grade encounter sits in.
 */
export function probabilityOfCollision(input: PcInput): number {
  const { primary, secondary, hardBodyRadiusKm } = input;
  if (!(hardBodyRadiusKm > 0)) return 0;

  const miss = vSub(secondary.position, primary.position);
  const relVel = vSub(secondary.velocity, primary.velocity);
  const vHat = vUnit(relVel);
  if (vNorm(vHat) === 0) return 0;

  // Combined covariance in ECI: C = C1 + C2, each Mᵢ diag(σ²) Mᵢᵀ.
  const cov = mat3Add(
    ricCovarianceEci(primary),
    ricCovarianceEci(secondary)
  );

  // Encounter plane basis: e1 along the (⊥-projected) miss vector,
  // e2 completes the right-handed set with v̂.
  const missPerp = vSub(miss, vScale(vHat, vDot(miss, vHat)));
  const d = vNorm(missPerp);
  let e1: Vec3;
  if (d > 1e-9) {
    e1 = vScale(missPerp, 1 / d);
  } else {
    // Head-on: any unit vector ⊥ v̂ works.
    const helper: Vec3 = Math.abs(vHat[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    e1 = vUnit(vCross(vHat, helper));
  }
  const e2 = vCross(vHat, e1);

  // 2-D projected covariance.
  const a = quadForm(e1, cov, e1);
  const b = quadForm(e1, cov, e2);
  const c = quadForm(e2, cov, e2);
  const det = a * c - b * b;
  if (!(det > 0) || !Number.isFinite(det)) return 0;

  const norm = 1 / (2 * Math.PI * Math.sqrt(det));
  const NR = 48;
  const NT = 96;
  const dr = hardBodyRadiusKm / NR;
  const dt = (2 * Math.PI) / NT;
  let sum = 0;
  for (let i = 0; i < NR; i++) {
    const rho = (i + 0.5) * dr;
    for (let j = 0; j < NT; j++) {
      const theta = (j + 0.5) * dt;
      const x = d + rho * Math.cos(theta);
      const y = rho * Math.sin(theta);
      const q = (c * x * x - 2 * b * x * y + a * y * y) / det;
      sum += Math.exp(-0.5 * q) * rho * dr * dt;
    }
  }
  const pc = sum * norm;
  if (!Number.isFinite(pc)) return 0;
  return Math.min(1, Math.max(0, pc));
}

type Mat3 = [Vec3, Vec3, Vec3]; // row-major

function ricCovarianceEci(state: PcObjectState): Mat3 {
  const f = ricFrame(state.position, state.velocity);
  const cols: Vec3[] = [f.radial, f.inTrack, f.crossTrack];
  const sig = state.sigmaRicKm;
  const out: Mat3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  // C = Σ_k σ_k² (col_k col_kᵀ)
  for (let k = 0; k < 3; k++) {
    const s2 = sig[k] * sig[k];
    const col = cols[k];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        out[r][c] += s2 * col[r] * col[c];
      }
    }
  }
  return out;
}

function mat3Add(a: Mat3, b: Mat3): Mat3 {
  return [
    [a[0][0] + b[0][0], a[0][1] + b[0][1], a[0][2] + b[0][2]],
    [a[1][0] + b[1][0], a[1][1] + b[1][1], a[1][2] + b[1][2]],
    [a[2][0] + b[2][0], a[2][1] + b[2][1], a[2][2] + b[2][2]],
  ];
}

/** xᵀ M y */
function quadForm(x: Vec3, m: Mat3, y: Vec3): number {
  let s = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      s += x[r] * m[r][c] * y[c];
    }
  }
  return s;
}

/* ------------------------------------------------------------
   Ground sites, synthetic orbits and two-body propagation
   (Session 6 — launch COLA screening, avoidance planning)
   ------------------------------------------------------------ */

/** ECI (TEME-equivalent) position of a ground site at an instant. */
export function siteEci(site: ObserverSite, date: Date): Vec3 {
  const ecf = satellite.geodeticToEcf({
    latitude: degToRad(site.latitudeDeg),
    longitude: degToRad(site.longitudeDeg),
    height: site.heightKm,
  });
  const eci = satellite.ecfToEci(ecf, gmstRadians(date));
  return [eci.x, eci.y, eci.z];
}

export interface CircularOrbitParams {
  altitudeKm: number; // above EARTH_EQUATORIAL_RADIUS_KM
  inclinationDeg: number;
  raanDeg: number;
  /** Argument of latitude (angle from the ascending node), degrees. */
  argLatDeg: number;
}

/** ECI state of a circular orbit from classical angles (two-body). */
export function circularOrbitState(p: CircularOrbitParams): StateVector {
  const r = EARTH_EQUATORIAL_RADIUS_KM + p.altitudeKm;
  const v = Math.sqrt(MU_EARTH_KM3_S2 / r);
  const i = degToRad(p.inclinationDeg);
  const O = degToRad(p.raanDeg);
  const u = degToRad(p.argLatDeg);
  const cO = Math.cos(O), sO = Math.sin(O);
  const ci = Math.cos(i), si = Math.sin(i);
  const cu = Math.cos(u), su = Math.sin(u);
  // Perifocal (x along node, y 90° ahead in-plane) -> ECI rotation.
  const position: Vec3 = [
    r * (cO * cu - sO * su * ci),
    r * (sO * cu + cO * su * ci),
    r * (su * si),
  ];
  const velocity: Vec3 = [
    v * (-cO * su - sO * cu * ci),
    v * (-sO * su + cO * cu * ci),
    v * (cu * si),
  ];
  return { position, velocity };
}

/**
 * Right ascension of the ascending node for an orbit of inclination
 * `inclinationDeg` whose plane contains the given ECI position (a
 * launch site at launch time), choosing the ASCENDING (northbound) pass:
 * north-east for prograde inclinations, north-west for retrograde ones
 * (e.g. SSO at 97.6°). Returns null when the site latitude exceeds
 * the inclination (no such plane exists).
 */
export function raanThroughPosition(
  positionEci: Vec3,
  inclinationDeg: number
): number | null {
  const [x, y, z] = positionEci;
  const rxy = Math.hypot(x, y);
  const alpha = Math.atan2(y, x);
  const delta = Math.atan2(z, rxy);
  const i = degToRad(inclinationDeg);
  if (Math.abs(Math.sin(i)) < 1e-9) return null;
  const s = -(Math.cos(i) * Math.tan(delta)) / Math.sin(i);
  if (!Number.isFinite(s) || Math.abs(s) > 1) return null;
  // Plane normal n = (sin i sin O, -sin i cos O, cos i); n·r = 0 gives
  // sin(O - alpha) = s. The ascending-pass solution is O = alpha + asin(s)
  // ... when the site is north of the node and moving northbound.
  return normalizeDeg360(radToDeg(alpha + Math.asin(s)));
}

/** Argument of latitude of a position (angle from the node), degrees. */
export function argumentOfLatitude(
  positionEci: Vec3,
  inclinationDeg: number,
  raanDeg: number
): number {
  const O = degToRad(raanDeg);
  const i = degToRad(inclinationDeg);
  const node: Vec3 = [Math.cos(O), Math.sin(O), 0];
  // In-plane direction 90° ahead of the node.
  const ahead: Vec3 = [-Math.sin(O) * Math.cos(i), Math.cos(O) * Math.cos(i), Math.sin(i)];
  const r = vUnit(positionEci);
  return normalizeDeg360(radToDeg(Math.atan2(vDot(r, ahead), vDot(r, node))));
}

/** Stumpff functions for universal-variable Kepler propagation. */
function stumpff(psi: number): { c2: number; c3: number } {
  if (psi > 1e-6) {
    const sq = Math.sqrt(psi);
    return { c2: (1 - Math.cos(sq)) / psi, c3: (sq - Math.sin(sq)) / Math.sqrt(psi * psi * psi) };
  }
  if (psi < -1e-6) {
    const sq = Math.sqrt(-psi);
    return {
      c2: (1 - Math.cosh(sq)) / psi,
      c3: (Math.sinh(sq) - sq) / Math.sqrt(-psi * psi * psi),
    };
  }
  return { c2: 0.5, c3: 1 / 6 };
}

/**
 * Two-body (Keplerian) propagation by `dtSeconds` using universal
 * variables (Vallado, Algorithm 8). Valid for any conic. Returns null
 * if the solver fails to converge (degenerate state).
 */
export function twoBodyPropagate(state: StateVector, dtSeconds: number): StateVector | null {
  const mu = MU_EARTH_KM3_S2;
  const r0v = state.position;
  const v0v = state.velocity;
  const r0 = vNorm(r0v);
  const v0 = vNorm(v0v);
  if (!(r0 > 0) || !Number.isFinite(dtSeconds)) return null;
  if (dtSeconds === 0) return { position: [...r0v] as Vec3, velocity: [...v0v] as Vec3 };
  const rdotv = vDot(r0v, v0v);
  const sqrtMu = Math.sqrt(mu);
  const alpha = -(v0 * v0) / mu + 2 / r0; // 1/a

  let chi: number;
  if (alpha > 1e-6) {
    chi = sqrtMu * dtSeconds * alpha;
  } else if (Math.abs(alpha) < 1e-6) {
    const h = vNorm(vCross(r0v, v0v));
    const pp = (h * h) / mu;
    const s = 0.5 * Math.atan(1 / ((3 * Math.sqrt(mu / (pp * pp * pp))) * dtSeconds));
    const w = Math.atan(Math.cbrt(Math.tan(s)));
    chi = Math.sqrt(pp) * 2 * (1 / Math.tan(2 * w));
  } else {
    const a = 1 / alpha;
    const sign = dtSeconds >= 0 ? 1 : -1;
    chi =
      sign *
      Math.sqrt(-a) *
      Math.log(
        (-2 * mu * alpha * dtSeconds) /
          (rdotv + sign * Math.sqrt(-mu * a) * (1 - r0 * alpha))
      );
  }

  let r = r0;
  let psi = 0;
  let c2 = 0.5;
  let c3 = 1 / 6;
  let converged = false;
  for (let iter = 0; iter < 60; iter++) {
    psi = chi * chi * alpha;
    ({ c2, c3 } = stumpff(psi));
    r =
      chi * chi * c2 +
      (rdotv / sqrtMu) * chi * (1 - psi * c3) +
      r0 * (1 - psi * c2);
    const chiNew =
      chi +
      (sqrtMu * dtSeconds -
        chi * chi * chi * c3 -
        (rdotv / sqrtMu) * chi * chi * c2 -
        r0 * chi * (1 - psi * c3)) /
        r;
    if (!Number.isFinite(chiNew)) return null;
    if (Math.abs(chiNew - chi) < 1e-8) {
      chi = chiNew;
      converged = true;
      break;
    }
    chi = chiNew;
  }
  if (!converged) return null;
  psi = chi * chi * alpha;
  ({ c2, c3 } = stumpff(psi));
  r = chi * chi * c2 + (rdotv / sqrtMu) * chi * (1 - psi * c3) + r0 * (1 - psi * c2);

  const f = 1 - (chi * chi / r0) * c2;
  const g = dtSeconds - (chi * chi * chi / sqrtMu) * c3;
  const gdot = 1 - (chi * chi / r) * c2;
  const fdot = (sqrtMu / (r * r0)) * chi * (psi * c3 - 1);

  const position: Vec3 = [
    f * r0v[0] + g * v0v[0],
    f * r0v[1] + g * v0v[1],
    f * r0v[2] + g * v0v[2],
  ];
  const velocity: Vec3 = [
    fdot * r0v[0] + gdot * v0v[0],
    fdot * r0v[1] + gdot * v0v[1],
    fdot * r0v[2] + gdot * v0v[2],
  ];
  if (!position.every(Number.isFinite) || !velocity.every(Number.isFinite)) return null;
  return { position, velocity };
}

/** Mean motion (rad/s) of a circular orbit at the given geocentric radius. */
export function meanMotionRadPerSec(radiusKm: number): number {
  return Math.sqrt(MU_EARTH_KM3_S2 / (radiusKm * radiusKm * radiusKm));
}

/* ------------------------------------------------------------
   Angle helpers
   ------------------------------------------------------------ */

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Normalize degrees to [0, 360). */
export function normalizeDeg360(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/** Normalize degrees to [-180, 180]. */
export function normalizeDeg180(deg: number): number {
  let d = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (d === -180) d = 180;
  return d;
}
