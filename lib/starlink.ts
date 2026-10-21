import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { classifyObjectName, meanAltitudeKm, tleElements } from "@/lib/orbital";

/* ============================================================
   SpaceDebris — Starlink constellation model (Session 6, F1)

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic.
   Runs in the browser on the shared 2,000-object Space-Track
   sample (lib/debrisClient) and in node tests.

   What it does
   1. Holds the public FCC-authorized Starlink shell table
      (Gen1 + the Dec-2022 Gen2 partial grant).
   2. Classifies every STARLINK-* element set in a sample into a
      shell and a lifecycle phase from ONE element set:
        OPERATIONAL               |inc − shell.inc| ≤ 1.5° and
                                  |alt − shell.alt| ≤ 25 km
                                  (nearest shell in altitude wins)
        DEORBITING                inclination matches a shell, the
                                  object is > 25 km BELOW it and
                                  under 300 km
        ORBIT RAISING / LOWERING  inclination matches a shell but the
                                  altitude is > 25 km off it (and not
                                  under 300 km). One TLE cannot tell
                                  raising from lowering, so the two
                                  share one bucket.
        UNASSIGNED                no shell inclination within 1.5°
   3. Counts the NON-Starlink objects whose perigee–apogee range
      crosses each shell (± crossingBandKm), split by coarse object
      class — the debris / rocket-body / payload population each
      shell flies through.

   ASSUMPTIONS (also printed on screen by StarlinkMonitor)
   - Altitude = (APOAPSIS + PERIAPSIS) / 2 from the gp strings
     (equatorial-radius convention, same as every other panel).
   - Shell altitudes / inclinations / counts are the public FCC
     authorizations. SpaceX can operate satellites at other
     altitudes under later modifications; such objects land in
     ORBIT RAISING / LOWERING here, which is literally what the
     single element set shows.
   - A freshly deployed batch below 300 km (before orbit raising)
     is indistinguishable from a deorbiting satellite in one
     element set; both read DEORBITING.
   - ORBIT RAISING / LOWERING and DEORBITING objects carry the
     inclination-matched shell NEAREST in altitude, not their target
     shell (one element set cannot show it). At 53° every off-station
     object 300-500 km is therefore attributed to the 525 km Gen2
     shell, and the three 53° shells' ±25 km windows overlap
     (500-575 km), so the split between them is approximate.
   - Crossing = altitude-band overlap only. No inclination, RAAN
     or phasing filter: a crossing object is a POTENTIAL
     conjunction partner, not a predicted conjunction.
   - Object class is the OBJECT_NAME heuristic from lib/orbital
     (" DEB" → debris, "R/B" → rocket body) — an estimate.
   - Rows with a Starlink name but unusable altitude / inclination
     strings are skipped and counted in `skippedInvalid`, never
     rendered as NaN.
   ============================================================ */

/* ------------------------------------------------------------
   Shell table — public FCC authorizations
   ------------------------------------------------------------ */

export interface StarlinkShell {
  id: string;
  /** Display label, e.g. "550 km · 53.0°". */
  label: string;
  altitudeKm: number;
  inclinationDeg: number;
  /** FCC-authorized satellite count; null when only a combined total exists (Gen2). */
  authorized: number | null;
  generation: "Gen1" | "Gen2";
  note: string;
}

/**
 * Gen2 Dec-2022 FCC partial grant: 7,500 satellites authorized
 * COMBINED across the 525 / 530 / 535 km shells (no per-shell split
 * in the grant), so each Gen2 shell carries authorized: null.
 */
export const GEN2_AUTHORIZED_TOTAL = 7500;

/**
 * Public FCC-authorized Starlink shells (counts: FCC-authorized,
 * public filings). Gen1 per the 2021 modification; Gen2 per the
 * Dec-2022 partial grant.
 */
export const STARLINK_SHELLS: StarlinkShell[] = [
  {
    id: "G1-550",
    label: "550 km · 53.0°",
    altitudeKm: 550,
    inclinationDeg: 53.0,
    authorized: 1584,
    generation: "Gen1",
    note: "Gen1 · original mid-inclination shell",
  },
  {
    id: "G1-540",
    label: "540 km · 53.2°",
    altitudeKm: 540,
    inclinationDeg: 53.2,
    authorized: 1584,
    generation: "Gen1",
    note: "Gen1 · second mid-inclination shell",
  },
  {
    id: "G1-570",
    label: "570 km · 70.0°",
    altitudeKm: 570,
    inclinationDeg: 70.0,
    authorized: 720,
    generation: "Gen1",
    note: "Gen1 · high-inclination shell",
  },
  {
    id: "G1-560",
    label: "560 km · 97.6°",
    altitudeKm: 560,
    inclinationDeg: 97.6,
    authorized: 520,
    generation: "Gen1",
    note: "Gen1 · polar shells (348 + 172 combined)",
  },
  {
    id: "G2-525",
    label: "525 km · 53.0°",
    altitudeKm: 525,
    inclinationDeg: 53.0,
    authorized: null,
    generation: "Gen2",
    note: "Gen2 · Dec-2022 partial grant",
  },
  {
    id: "G2-530",
    label: "530 km · 43.0°",
    altitudeKm: 530,
    inclinationDeg: 43.0,
    authorized: null,
    generation: "Gen2",
    note: "Gen2 · Dec-2022 partial grant",
  },
  {
    id: "G2-535",
    label: "535 km · 33.0°",
    altitudeKm: 535,
    inclinationDeg: 33.0,
    authorized: null,
    generation: "Gen2",
    note: "Gen2 · Dec-2022 partial grant · low inclination",
  },
];

/** Sum of the per-shell Gen1 authorizations (4,408). */
export const GEN1_AUTHORIZED_TOTAL = STARLINK_SHELLS.reduce(
  (sum, s) => (s.generation === "Gen1" && s.authorized !== null ? sum + s.authorized : sum),
  0
);

/* ------------------------------------------------------------
   Classification thresholds
   ------------------------------------------------------------ */

/** Inclination tolerance for a shell match (degrees, inclusive). */
export const SHELL_MATCH_INC_DEG = 1.5;
/** Altitude tolerance for OPERATIONAL (km, inclusive) — also the ladder band half-width. */
export const SHELL_MATCH_ALT_KM = 25;
/** Below this mean altitude an off-shell object is labelled DEORBITING. */
export const DEORBIT_ALTITUDE_KM = 300;
/** Default ± band around a shell for the crossing-object count. */
export const DEFAULT_CROSSING_BAND_KM = 15;

/** Float slack so a tolerance boundary such as 54.5 vs 53.0 is inclusive. */
const EPS = 1e-9;

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

export type StarlinkPhase =
  | "OPERATIONAL"
  | "ORBIT RAISING / LOWERING"
  | "DEORBITING"
  | "UNASSIGNED";

/** Display order for phases (stat cells, ladder legend). */
export const STARLINK_PHASES: readonly StarlinkPhase[] = [
  "OPERATIONAL",
  "ORBIT RAISING / LOWERING",
  "DEORBITING",
  "UNASSIGNED",
];

export interface StarlinkObject {
  noradId: string;
  name: string;
  /** (APOAPSIS + PERIAPSIS) / 2 from the gp strings, km. Always finite and > 0. */
  altitudeKm: number;
  /** Always finite, 0–180°. */
  inclinationDeg: number;
  /**
   * OPERATIONAL: the shell it is on. ORBIT RAISING / LOWERING and
   * DEORBITING: the inclination-matched shell nearest in altitude.
   * UNASSIGNED: null.
   */
  shellId: string | null;
  phase: StarlinkPhase;
  /** TLE line-1 cols 34-43 (ṅ/2, rev/day²) via lib/orbital tleElements; null if unparseable. */
  ndotHalfRevPerDay2: number | null;
}

export interface CrossingCounts {
  debris: number;
  rocketBody: number;
  payload: number;
  unknown: number;
  total: number;
}

export interface ShellReport {
  shell: StarlinkShell;
  operational: number;
  /** Phase ORBIT RAISING / LOWERING attributed to this shell. */
  transit: number;
  /** Mean altitude of this shell's OPERATIONAL objects; null when none. */
  meanAltitudeKm: number | null;
  /** Population standard deviation (1σ) of OPERATIONAL altitudes; null when fewer than 2. */
  altitudeSpreadKm: number | null;
  crossing: CrossingCounts;
}

export interface StarlinkReport {
  starlinkTotal: number;
  operational: number;
  transit: number;
  deorbiting: number;
  unassigned: number;
  /** starlinkTotal / sample length, 0–1 (0 for an empty sample). */
  shareOfSample: number;
  shells: ShellReport[];
  objects: StarlinkObject[];
  /** Total rows in the sample passed in. */
  sampleSize: number;
  /** Starlink-named rows dropped for unusable altitude / inclination strings. */
  skippedInvalid: number;
  /** The ± km band actually used for the crossing counts. */
  crossingBandKm: number;
}

/* ------------------------------------------------------------
   Helpers
   ------------------------------------------------------------ */

const STARLINK_NAME_RE = /^STARLINK/i;

/** True for Space-Track OBJECT_NAMEs such as "STARLINK-1234". */
export function isStarlinkName(name: string | undefined | null): boolean {
  if (typeof name !== "string") return false;
  return STARLINK_NAME_RE.test(name.trim());
}

/** Shell lookup by id; null for unknown / null ids. */
export function shellById(id: string | null | undefined): StarlinkShell | null {
  if (!id) return null;
  return STARLINK_SHELLS.find((s) => s.id === id) ?? null;
}

/** Compact shell label for charts: "550 · 53°", "540 · 53.2°". */
export function shellShortLabel(shell: StarlinkShell): string {
  const inc = shell.inclinationDeg;
  const incStr = Number.isInteger(inc) ? String(inc) : inc.toFixed(1);
  return `${shell.altitudeKm} · ${incStr}°`;
}

export interface ShellMatch {
  shell: StarlinkShell | null;
  phase: StarlinkPhase;
}

/**
 * Shell + phase for one (altitude, inclination) pair. Exported so the
 * rule can be unit-tested without fabricating gp rows.
 */
export function matchStarlinkShell(altitudeKm: number, inclinationDeg: number): ShellMatch {
  if (!Number.isFinite(altitudeKm) || !Number.isFinite(inclinationDeg)) {
    return { shell: null, phase: "UNASSIGNED" };
  }

  let best: StarlinkShell | null = null;
  let bestDiff = Infinity;
  for (const s of STARLINK_SHELLS) {
    if (Math.abs(inclinationDeg - s.inclinationDeg) > SHELL_MATCH_INC_DEG + EPS) continue;
    const d = Math.abs(altitudeKm - s.altitudeKm);
    if (d < bestDiff) {
      best = s;
      bestDiff = d;
    }
  }

  if (!best) return { shell: null, phase: "UNASSIGNED" };
  if (bestDiff <= SHELL_MATCH_ALT_KM + EPS) return { shell: best, phase: "OPERATIONAL" };
  if (altitudeKm < best.altitudeKm && altitudeKm < DEORBIT_ALTITUDE_KM) {
    return { shell: best, phase: "DEORBITING" };
  }
  // > 25 km below the shell but ≥ 300 km, or > 25 km above it: off-station
  // in a shell's plane. One element set cannot say which way it is moving.
  return { shell: best, phase: "ORBIT RAISING / LOWERING" };
}

/**
 * TLE line-1 ṅ/2 through lib/orbital tleElements (which owns the
 * satellite.js quirks). tleElements falls back to 0 for an unparseable
 * field, so the raw columns are re-checked to report null instead.
 */
function ndotHalf(obj: SpaceTrackTLE): number | null {
  const el = tleElements(obj);
  if (!el) return null;
  const raw = parseFloat(obj.TLE_LINE1.substring(33, 43));
  if (!Number.isFinite(raw) || !Number.isFinite(el.ndotHalfRevPerDay2)) return null;
  return el.ndotHalfRevPerDay2;
}

/**
 * Classify one gp row. null unless the name is STARLINK* AND the
 * altitude / inclination strings give a finite, physical orbit
 * (mean altitude > 0 km, inclination 0–180°).
 */
export function classifyStarlink(obj: SpaceTrackTLE): StarlinkObject | null {
  if (!obj || !isStarlinkName(obj.OBJECT_NAME)) return null;

  const altitudeKm = meanAltitudeKm(obj);
  const inclinationDeg = parseFloat(obj.INCLINATION);
  if (!Number.isFinite(altitudeKm) || altitudeKm <= 0) return null;
  if (!Number.isFinite(inclinationDeg) || inclinationDeg < 0 || inclinationDeg > 180) {
    return null;
  }

  const { shell, phase } = matchStarlinkShell(altitudeKm, inclinationDeg);
  const noradId = typeof obj.NORAD_CAT_ID === "string" ? obj.NORAD_CAT_ID.trim() : "";

  return {
    noradId,
    name: obj.OBJECT_NAME.trim(),
    altitudeKm,
    inclinationDeg,
    shellId: shell ? shell.id : null,
    phase,
    ndotHalfRevPerDay2: ndotHalf(obj),
  };
}

function emptyCrossing(): CrossingCounts {
  return { debris: 0, rocketBody: 0, payload: 0, unknown: 0, total: 0 };
}

/* ------------------------------------------------------------
   Report
   ------------------------------------------------------------ */

/**
 * Build the constellation report for a gp sample.
 * crossingBandKm: ± km around each shell's nominal altitude; a
 * non-Starlink object crosses the shell when
 *   perigee ≤ shell.alt + band  AND  apogee ≥ shell.alt − band.
 * Non-finite / negative bands fall back to DEFAULT_CROSSING_BAND_KM.
 */
export function buildStarlinkReport(
  sample: SpaceTrackTLE[],
  crossingBandKm: number = DEFAULT_CROSSING_BAND_KM
): StarlinkReport {
  const rows = Array.isArray(sample) ? sample : [];
  const band =
    Number.isFinite(crossingBandKm) && crossingBandKm >= 0
      ? crossingBandKm
      : DEFAULT_CROSSING_BAND_KM;

  const opAltitudes = new Map<string, number[]>();
  const transitCount = new Map<string, number>();
  const crossing = new Map<string, CrossingCounts>();
  for (const s of STARLINK_SHELLS) {
    opAltitudes.set(s.id, []);
    transitCount.set(s.id, 0);
    crossing.set(s.id, emptyCrossing());
  }

  const objects: StarlinkObject[] = [];
  let operational = 0;
  let transit = 0;
  let deorbiting = 0;
  let unassigned = 0;
  let skippedInvalid = 0;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    if (isStarlinkName(row.OBJECT_NAME)) {
      const o = classifyStarlink(row);
      if (!o) {
        skippedInvalid++;
        continue;
      }
      objects.push(o);
      switch (o.phase) {
        case "OPERATIONAL": {
          operational++;
          if (o.shellId) opAltitudes.get(o.shellId)?.push(o.altitudeKm);
          break;
        }
        case "ORBIT RAISING / LOWERING": {
          transit++;
          if (o.shellId) transitCount.set(o.shellId, (transitCount.get(o.shellId) ?? 0) + 1);
          break;
        }
        case "DEORBITING":
          deorbiting++;
          break;
        case "UNASSIGNED":
          unassigned++;
          break;
      }
      continue;
    }

    // Non-Starlink object: which shells does its perigee–apogee range cross?
    const apo = parseFloat(row.APOAPSIS);
    const peri = parseFloat(row.PERIAPSIS);
    if (!Number.isFinite(apo) || !Number.isFinite(peri)) continue;
    const lo = Math.min(apo, peri);
    const hi = Math.max(apo, peri);
    const cls = classifyObjectName(row.OBJECT_NAME);

    for (const s of STARLINK_SHELLS) {
      if (lo <= s.altitudeKm + band && hi >= s.altitudeKm - band) {
        const c = crossing.get(s.id);
        if (!c) continue;
        if (cls === "DEBRIS") c.debris++;
        else if (cls === "ROCKET BODY") c.rocketBody++;
        else if (cls === "PAYLOAD") c.payload++;
        else c.unknown++;
        c.total++;
      }
    }
  }

  const shells: ShellReport[] = STARLINK_SHELLS.map((shell) => {
    const alts = opAltitudes.get(shell.id) ?? [];
    let mean: number | null = null;
    let spread: number | null = null;
    if (alts.length > 0) {
      let sum = 0;
      for (const a of alts) sum += a;
      mean = sum / alts.length;
      if (alts.length >= 2) {
        let ss = 0;
        for (const a of alts) ss += (a - mean) * (a - mean);
        spread = Math.sqrt(ss / alts.length);
      }
    }
    return {
      shell,
      operational: alts.length,
      transit: transitCount.get(shell.id) ?? 0,
      meanAltitudeKm: mean,
      altitudeSpreadKm: spread,
      crossing: crossing.get(shell.id) ?? emptyCrossing(),
    };
  });

  const starlinkTotal = objects.length;

  return {
    starlinkTotal,
    operational,
    transit,
    deorbiting,
    unassigned,
    shareOfSample: rows.length > 0 ? starlinkTotal / rows.length : 0,
    shells,
    objects,
    sampleSize: rows.length,
    skippedInvalid,
    crossingBandKm: band,
  };
}
