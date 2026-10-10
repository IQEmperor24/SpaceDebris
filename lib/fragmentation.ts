import type { SpaceTrackTLE } from "@/lib/spacetrack";
import type { OrbitalShell } from "@/lib/orbital";
import {
  classifyObjectName,
  classifyShell,
  launchDesignator,
  meanAltitudeKm,
} from "@/lib/orbital";

/* ============================================================
   SpaceDebris — Fragmentation Family Tracker (pure helpers)

   ODPO-style breakup attribution of the live Space-Track sample.

   PURE FUNCTIONS ONLY: no React, no network, no Anthropic. Runs
   identically in the browser (components/FragmentationTracker)
   and under plain Node for tests.

   Data flow
   1. The browser already holds the 2,000-object gp sample
      (lib/debrisClient.ts — the same rows OrbitalMap draws).
   2. groupFamilies() buckets every object by its LAUNCH
      DESIGNATOR (the "YYYY-NNN" prefix of OBJECT_ID, i.e. the
      international designator). Every fragment of a breakup
      keeps its parent's launch designator, so the designator IS
      the family key — exactly how ODPO / ESA DISCOS attribute
      fragments to a parent.
   3. A family is attributed to a cataloged breakup ONLY when
      BOTH factors hold:
        (a) the launch designator matches the catalog entry, AND
        (b) at least one object name in the family matches the
            entry's nameMatch pattern.
      The two-factor check means a typo'd / recycled designator
      can never mislabel an unrelated family as, say, FENGYUN 1C.
   4. Families are sorted by object count (desc), tie-broken by
      debris count (desc), then designator (asc) for determinism,
      and capped at maxFamilies (default 10). Groups with a
      single object are dropped — one object is not a "family".

   Assumptions (surfaced verbatim in the panel footnote)
   - The sample is the 2,000 most-recently-updated element sets
     in Space-Track's gp class, NOT the full ~46k-object catalog,
     so family counts describe the sample only.
   - approxCatalogedFragments / approxAltitudeKm in the catalog
     are approximate public figures from NASA ODPO Orbital Debris
     Quarterly News and ESA Space Environment reporting. They are
     labelled "approx" everywhere and are never recomputed.
   - Mean altitude = (APOAPSIS + PERIAPSIS) / 2 from the gp string
     fields (lib/orbital meanAltitudeKm); mean inclination from
     the gp INCLINATION string. Non-finite values are skipped.
   - Object class comes from the Space-Track OBJECT_NAME suffix
     (" DEB" = fragmentation debris, " R/B" = rocket body) via
     lib/orbital classifyObjectName.
   ============================================================ */

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

/**
 * Breakup cause, ODPO vocabulary:
 *   ASAT       — deliberate anti-satellite test
 *   COLLISION  — accidental hypervelocity collision
 *   EXPLOSION  — propulsion / pressurant / battery explosion
 *   ANOMALOUS  — unexplained low-energy fragmentation
 *   UNKNOWN    — cause not determined
 */
export type BreakupType =
  | "ASAT"
  | "COLLISION"
  | "EXPLOSION"
  | "ANOMALOUS"
  | "UNKNOWN";

/** One cataloged fragmentation event (public ODPO / ESA figures). */
export interface BreakupEvent {
  /** International (launch) designator of the parent, "YYYY-NNN". */
  launchDesignator: string;
  parentName: string;
  eventType: BreakupType;
  /** ISO calendar date "YYYY-MM-DD" (UTC) of the breakup. */
  eventDate: string;
  /** Approximate number of cataloged fragments (public reporting). */
  approxCatalogedFragments: number;
  /** Approximate breakup altitude (km). */
  approxAltitudeKm: number;
  /**
   * Second attribution factor: a family is tagged with this event
   * ONLY if the designator matches AND some object name in the
   * family matches this pattern. Never add the `g` flag — a
   * stateful regex would make .test() order-dependent.
   */
  nameMatch: RegExp;
  note: string;
}

/** One launch family found in the sample. */
export interface DebrisFamily {
  launchDesignator: string;
  /** Catalog parent name when attributed, else derived from the names. */
  parentName: string;
  /** All objects in the sample sharing this launch designator. */
  count: number;
  /** Objects classified DEBRIS (" DEB" suffix) in this family. */
  debrisCount: number;
  /** count / totalObjects — a FRACTION in [0, 1], not a percentage. */
  shareOfSample: number;
  /** Mean of (apoapsis + periapsis)/2 over finite values; null if none. */
  meanAltitudeKm: number | null;
  /** Mean INCLINATION over finite values; null if none. */
  meanInclinationDeg: number | null;
  /** classifyShell(meanAltitudeKm); null when altitude is unknown. */
  shell: OrbitalShell | null;
  /** Attributed catalog event (two-factor match) or null. */
  event: BreakupEvent | null;
}

/** groupFamilies() output. Sample-wide stats + the capped family table. */
export interface FamilyReport {
  /** objects.length — the whole sample, including rows with no designator. */
  totalObjects: number;
  /** Objects classified DEBRIS anywhere in the sample. */
  debrisObjects: number;
  /**
   * Debris objects sitting in a family attributed to a cataloged
   * breakup. Sample-wide: NOT limited by the count ≥ 2 filter or
   * the maxFamilies cap, so the stat describes the sample, not
   * the table.
   */
  attributedDebrisObjects: number;
  /** Sorted desc by count, then debrisCount; count ≥ 2; ≤ maxFamilies. */
  families: DebrisFamily[];
  /** Distinct catalog events attributed to at least one group (sample-wide). */
  catalogEventsPresent: number;
}

/* ------------------------------------------------------------
   Breakup catalog
   Figures: public NASA ODPO (Orbital Debris Quarterly News) and
   ESA Space Environment Report. Keep the numbers as given — they
   are approximate cataloged counts and are labelled as such.
   ------------------------------------------------------------ */

export const BREAKUP_CATALOG: BreakupEvent[] = [
  {
    launchDesignator: "1999-025",
    parentName: "FENGYUN 1C",
    eventType: "ASAT",
    eventDate: "2007-01-11",
    approxCatalogedFragments: 3500,
    approxAltitudeKm: 865,
    nameMatch: /FENGYUN/i,
    note:
      "Chinese direct-ascent ASAT test. Largest debris-generating event on record; most fragments remain in orbit.",
  },
  {
    launchDesignator: "1993-036",
    parentName: "COSMOS 2251",
    eventType: "COLLISION",
    eventDate: "2009-02-10",
    approxCatalogedFragments: 1700,
    approxAltitudeKm: 790,
    nameMatch: /COSMOS 2251/i,
    note:
      "First accidental hypervelocity collision of two intact satellites (with Iridium 33).",
  },
  {
    launchDesignator: "1997-051",
    parentName: "IRIDIUM 33",
    eventType: "COLLISION",
    eventDate: "2009-02-10",
    approxCatalogedFragments: 630,
    approxAltitudeKm: 790,
    nameMatch: /IRIDIUM 33/i,
    note: "Operational Iridium satellite destroyed by Cosmos 2251.",
  },
  {
    launchDesignator: "1982-092",
    parentName: "COSMOS 1408",
    eventType: "ASAT",
    eventDate: "2021-11-15",
    approxCatalogedFragments: 1800,
    approxAltitudeKm: 480,
    nameMatch: /COSMOS 1408/i,
    note:
      "Russian direct-ascent ASAT test; ISS crew sheltered in their return vehicles.",
  },
  {
    launchDesignator: "2022-151",
    parentName: "CZ-6A R/B (YUNHAI 3)",
    eventType: "EXPLOSION",
    eventDate: "2022-11-12",
    approxCatalogedFragments: 800,
    approxAltitudeKm: 830,
    nameMatch: /CZ-6A|LONG MARCH 6A|YUNHAI/i,
    note: "Long March 6A upper-stage breakup shortly after launch.",
  },
  {
    launchDesignator: "2024-140",
    parentName: "CZ-6A R/B (QIANFAN)",
    eventType: "EXPLOSION",
    eventDate: "2024-08-06",
    approxCatalogedFragments: 700,
    approxAltitudeKm: 810,
    nameMatch: /CZ-6A|LONG MARCH 6A|QIANFAN/i,
    note:
      "Long March 6A upper-stage breakup after deploying the first Qianfan batch.",
  },
  {
    launchDesignator: "2000-055",
    parentName: "NOAA 16",
    eventType: "ANOMALOUS",
    eventDate: "2015-11-25",
    approxCatalogedFragments: 450,
    approxAltitudeKm: 850,
    nameMatch: /NOAA 16/i,
    note: "Battery-related breakup of a decommissioned weather satellite.",
  },
  {
    launchDesignator: "1995-015",
    parentName: "DMSP 5D-2 F13",
    eventType: "EXPLOSION",
    eventDate: "2015-02-03",
    approxCatalogedFragments: 240,
    approxAltitudeKm: 840,
    nameMatch: /DMSP/i,
    note: "Battery rupture of a retired military weather satellite.",
  },
  {
    launchDesignator: "1994-029",
    parentName: "PEGASUS HAPS R/B",
    eventType: "EXPLOSION",
    eventDate: "1996-06-03",
    approxCatalogedFragments: 750,
    approxAltitudeKm: 625,
    nameMatch: /PEGASUS|HAPS/i,
    note:
      "Hydrazine Auxiliary Propulsion System stage explosion two years after launch.",
  },
  {
    launchDesignator: "1986-019",
    parentName: "ARIANE 1 R/B (SPOT 1)",
    eventType: "EXPLOSION",
    eventDate: "1986-11-13",
    approxCatalogedFragments: 490,
    approxAltitudeKm: 800,
    nameMatch: /ARIANE|SPOT/i,
    note:
      "Third-stage explosion; a defining event for Western debris-mitigation guidelines.",
  },
  {
    launchDesignator: "2019-063",
    parentName: "YUNHAI 1-02",
    eventType: "COLLISION",
    eventDate: "2021-03-18",
    approxCatalogedFragments: 40,
    approxAltitudeKm: 780,
    nameMatch: /YUNHAI 1-02/i,
    note:
      "Hit by a fragment of a Zenit-2 rocket body — the first confirmed debris-on-satellite collision since 2009.",
  },
];

/** Designator → catalog entries (built once; the catalog is static). */
const CATALOG_BY_DESIGNATOR: ReadonlyMap<string, BreakupEvent[]> = (() => {
  const m = new Map<string, BreakupEvent[]>();
  for (const ev of BREAKUP_CATALOG) {
    const list = m.get(ev.launchDesignator);
    if (list) list.push(ev);
    else m.set(ev.launchDesignator, [ev]);
  }
  return m;
})();

/* ------------------------------------------------------------
   Attribution + naming helpers (exported for tests / reuse)
   ------------------------------------------------------------ */

/**
 * Two-factor attribution: designator must match a catalog entry AND
 * at least one object name must match that entry's nameMatch.
 * Returns the first catalog entry satisfying both, else null.
 */
export function attributeBreakupEvent(
  designator: string,
  names: readonly string[]
): BreakupEvent | null {
  const candidates = CATALOG_BY_DESIGNATOR.get(designator);
  if (!candidates || candidates.length === 0) return null;
  for (const ev of candidates) {
    for (const name of names) {
      if (typeof name === "string" && ev.nameMatch.test(name)) return ev;
    }
  }
  return null;
}

/**
 * Remove trailing " DEB" / " R/B" tokens from a Space-Track object
 * name: "FENGYUN 1C DEB" → "FENGYUN 1C", "SL-16 R/B" → "SL-16".
 * Space-Track also writes stage-qualified rocket bodies as
 * "SL-12 R/B(2)" — the "(n)" qualifier is part of the R/B token and
 * is stripped with it. Repeats so "FOO R/B DEB" → "FOO". Falls back
 * to the trimmed input when stripping would leave nothing.
 */
export function stripObjectSuffix(name: string): string {
  const trimmed = (name ?? "").trim();
  let out = trimmed;
  // Loop: a name can carry more than one trailing class token.
  for (let guard = 0; guard < 4; guard++) {
    const next = out.replace(/\s+(DEB|R\/B(\([^)]*\))?)$/i, "").trim();
    if (next === out) break;
    out = next;
  }
  return out.length > 0 ? out : trimmed;
}

/**
 * Parent name for an UNATTRIBUTED family: the most frequent object
 * name after stripping trailing " DEB" / " R/B" tokens. Ties go to
 * the first-seen name so the result is deterministic for a given
 * input order. Returns "UNKNOWN" when no usable name exists.
 */
export function deriveParentName(names: readonly string[]): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const stripped = stripObjectSuffix(raw);
    if (!stripped) continue;
    const prev = counts.get(stripped);
    if (prev === undefined) {
      counts.set(stripped, 1);
      order.push(stripped);
    } else {
      counts.set(stripped, prev + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const name of order) {
    const c = counts.get(name) ?? 0;
    if (c > bestCount) {
      best = name;
      bestCount = c;
    }
  }
  return best ?? "UNKNOWN";
}

/* ------------------------------------------------------------
   Grouping
   ------------------------------------------------------------ */

interface GroupAccumulator {
  designator: string;
  count: number;
  debrisCount: number;
  names: string[];
  altSum: number;
  altN: number;
  incSum: number;
  incN: number;
}

/**
 * Group the sample into launch families and attribute cataloged
 * breakups. See the header comment for the exact rules.
 *
 * Only OBJECT_ID, OBJECT_NAME, APOAPSIS, PERIAPSIS and INCLINATION
 * are read; every other SpaceTrackTLE field is ignored.
 */
export function groupFamilies(
  objects: SpaceTrackTLE[],
  maxFamilies = 10
): FamilyReport {
  const safeInput = Array.isArray(objects) ? objects : [];
  const cap = Number.isFinite(maxFamilies)
    ? Math.max(0, Math.floor(maxFamilies))
    : 10;

  const groups = new Map<string, GroupAccumulator>();
  let debrisObjects = 0;

  for (const o of safeInput) {
    if (!o || typeof o !== "object") continue;
    const isDebris = classifyObjectName(o.OBJECT_NAME) === "DEBRIS";
    if (isDebris) debrisObjects++;

    const designator = launchDesignator(o.OBJECT_ID);
    if (!designator) continue; // no usable international designator

    let g = groups.get(designator);
    if (!g) {
      g = {
        designator,
        count: 0,
        debrisCount: 0,
        names: [],
        altSum: 0,
        altN: 0,
        incSum: 0,
        incN: 0,
      };
      groups.set(designator, g);
    }

    g.count++;
    if (isDebris) g.debrisCount++;
    if (typeof o.OBJECT_NAME === "string") g.names.push(o.OBJECT_NAME);

    const alt = meanAltitudeKm(o);
    if (Number.isFinite(alt)) {
      g.altSum += alt;
      g.altN++;
    }
    const inc = parseFloat(o.INCLINATION);
    if (Number.isFinite(inc)) {
      g.incSum += inc;
      g.incN++;
    }
  }

  const totalObjects = safeInput.length;
  const eventsPresent = new Set<string>();
  let attributedDebrisObjects = 0;
  const families: DebrisFamily[] = [];

  // Map.forEach (not for-of over .values()) — tsconfig sets no explicit
  // target, so TS compiles against ES5 where iterators cannot be spread.
  groups.forEach((g) => {
    // Attribution is evaluated for EVERY group (sample-wide stats),
    // even singletons that never reach the family table.
    const event = attributeBreakupEvent(g.designator, g.names);
    if (event) {
      eventsPresent.add(event.launchDesignator);
      attributedDebrisObjects += g.debrisCount;
    }

    if (g.count < 2) return; // a single object is not a family

    const meanAlt = g.altN > 0 ? g.altSum / g.altN : null;
    const meanInc = g.incN > 0 ? g.incSum / g.incN : null;

    families.push({
      launchDesignator: g.designator,
      parentName: event ? event.parentName : deriveParentName(g.names),
      count: g.count,
      debrisCount: g.debrisCount,
      shareOfSample: totalObjects > 0 ? g.count / totalObjects : 0,
      meanAltitudeKm: meanAlt,
      meanInclinationDeg: meanInc,
      shell: meanAlt !== null ? classifyShell(meanAlt) : null,
      event,
    });
  });

  families.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.debrisCount !== a.debrisCount) return b.debrisCount - a.debrisCount;
    // Deterministic final tie-break (plain code-point compare, locale-free).
    if (a.launchDesignator < b.launchDesignator) return -1;
    if (a.launchDesignator > b.launchDesignator) return 1;
    return 0;
  });

  return {
    totalObjects,
    debrisObjects,
    attributedDebrisObjects,
    families: families.slice(0, cap),
    catalogEventsPresent: eventsPresent.size,
  };
}
