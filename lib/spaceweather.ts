/* ============================================================
   SpaceDebris — Space weather (NOAA SWPC) types, parsers and
   drag-regime logic

   PURE MODULE: no fetch, no React, no Node APIs. The route
   (app/api/spaceweather/route.ts) performs the two HTTP requests
   and hands the RAW JSON to the parsers below, so every piece of
   logic here is unit-testable with fixtures and runs identically
   on the server and in the browser (components/SpaceWeather.tsx
   imports the regime helpers + explanations for display).

   Data sources (public, no key, CORS-irrelevant because the route
   fetches server-side):
   - Planetary Kp — NOAA SWPC "Estimated Planetary K index" product.
     Array of arrays; row 0 is the header
       ["time_tag","Kp","a_running","station_count"]
     and every later row holds STRINGS, e.g.
       ["2026-10-10 15:00:00.000","3.33","18","8"].
   - F10.7 — NOAA SWPC 10.7 cm solar radio flux (Penticton), in
     solar flux units (sfu, 1 sfu = 10⁻²² W m⁻² Hz⁻¹).
     Array of objects { time_tag: string, flux: number|string, … }.

   Why these two indices matter for debris work:
   - F10.7 is the standard proxy for solar EUV heating of the
     thermosphere, i.e. the dominant driver of neutral density
     (and therefore drag) between ~200 and ~800 km.
   - Kp measures geomagnetic activity; a storm (Kp ≥ 5, NOAA G1+)
     dumps Joule heating into the upper atmosphere and can raise
     LEO density by a factor of several within hours, which is
     exactly when SGP4/TLE predictions degrade fastest.

   The drag regime below is a HEURISTIC INDICATOR for situational
   awareness. It is not a density model (no NRLMSISE-00 / JB2008
   evaluation) and is labelled that way in the UI.
   ============================================================ */

/* ------------------------------------------------------------
   Endpoints — the ONLY two URLs the /api/spaceweather route may
   fetch. Both are public NOAA SWPC products.
   ------------------------------------------------------------ */

export const SWPC_KP_URL =
  "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
export const SWPC_F107_URL =
  "https://services.swpc.noaa.gov/json/f107_cm_flux.json";

/* ------------------------------------------------------------
   Types
   ------------------------------------------------------------ */

/** NOAA Space Weather Scale for geomagnetic storms (G0 = below G1). */
export type GeomagneticScale = "G0" | "G1" | "G2" | "G3" | "G4" | "G5";

/** Qualitative thermospheric-drag environment for LEO. */
export type DragRegime = "LOW" | "MODERATE" | "ELEVATED" | "HIGH" | "UNKNOWN";

/** One index reading: numeric value + the SWPC time tag (UTC). */
export interface SpaceWeatherReading {
  value: number;
  /** Raw SWPC time tag, e.g. "2026-10-10 15:00:00.000" or "2026-10-10T20:00:00". */
  timeTag: string;
}

/** Output of GET /api/spaceweather. */
export interface SpaceWeatherStatus {
  /** ISO timestamp of when the route fetched the upstream feeds. */
  fetchedAt: string;
  kp: SpaceWeatherReading | null;
  f107: SpaceWeatherReading | null;
  /** Derived from kp; null when kp is null. */
  gScale: GeomagneticScale | null;
  dragRegime: DragRegime;
  /** Per-feed failure messages; a key is present only when that feed failed. */
  errors: { kp?: string; f107?: string };
}

/* ------------------------------------------------------------
   Thresholds (single source of truth — the component imports
   these so its labels can never drift from the logic).
   ------------------------------------------------------------ */

/** Kp at or above this is a NOAA G1 (minor) geomagnetic storm. */
export const KP_STORM_THRESHOLD = 5;

/** F10.7 (sfu) upper bounds for the base drag regime. */
export const F107_LOW_MAX = 100;
export const F107_MODERATE_MAX = 150;
export const F107_ELEVATED_MAX = 200;

/** Ordered from calmest to most severe — used for the Kp "bump". */
const REGIME_ORDER: ReadonlyArray<Exclude<DragRegime, "UNKNOWN">> = [
  "LOW",
  "MODERATE",
  "ELEVATED",
  "HIGH",
];

/* ------------------------------------------------------------
   Small guards
   ------------------------------------------------------------ */

/**
 * Coerce an SWPC cell (number or numeric string) to a finite number.
 * Returns null for "", "Kp" (header), null, undefined, NaN, etc.
 */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = parseFloat(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toTimeTag(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* ------------------------------------------------------------
   Time tags — SWPC stamps are UTC but carry no zone designator
   and come in two spellings ("2026-10-10 15:00:00.000" in the Kp
   product, "2026-10-10T20:00:00" in F10.7). Normalise ONCE here:
   the parsers use the epoch-ms form to pick the NEWEST row and
   formatTimeTagUtc (bottom of file) uses it for display.
   ------------------------------------------------------------ */

/**
 * Epoch milliseconds for an SWPC time tag, or null when the tag is
 * blank or does not parse. A leading YYYY-MM-DD is required so a
 * stray numeric cell (e.g. 12345 → "12345Z", a valid far-future
 * Date) can never masquerade as the newest reading.
 */
export function parseTimeTagMs(timeTag: string | null | undefined): number | null {
  if (typeof timeTag !== "string") return null;
  const raw = timeTag.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;

  // "2026-10-10 15:00:00.000" → "2026-10-10T15:00:00.000"; add Z when
  // no zone designator / offset is present so Date treats it as UTC.
  let iso = raw.replace(" ", "T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso = `${iso}Z`;

  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/* ------------------------------------------------------------
   Parsers — tolerate header rows, string numbers, blank cells,
   and odd column orders. Each returns the NEWEST usable reading
   BY TIME TAG, so the result is identical whether NOAA serves a
   product oldest-first (the Kp product does) or newest-first (the
   F10.7 ordering is unverified from this sandbox). When no row has
   a parseable time tag the positionally LAST finite row is used.
   ------------------------------------------------------------ */

/**
 * Walk every row, extract a reading, and keep the one with the
 * greatest time tag (a later row wins a tie). Falls back to the
 * last finite row when no time tag parses at all.
 */
function selectNewestReading(
  rows: ReadonlyArray<unknown>,
  extract: (row: unknown) => SpaceWeatherReading | null
): SpaceWeatherReading | null {
  let newest: SpaceWeatherReading | null = null;
  let newestMs = -Infinity;
  let lastFinite: SpaceWeatherReading | null = null;

  for (const row of rows) {
    const reading = extract(row);
    if (!reading) continue; // header row, blank trailing cell, junk
    lastFinite = reading;
    const ms = parseTimeTagMs(reading.timeTag);
    if (ms !== null && ms >= newestMs) {
      newestMs = ms;
      newest = reading;
    }
  }
  return newest ?? lastFinite;
}

/**
 * Parse the SWPC planetary-Kp product (array of arrays, header in
 * row 0). Returns the data row with the NEWEST time_tag whose Kp is
 * finite (positionally last finite row if no time tag parses), or
 * null.
 *
 * Column positions default to time_tag = 0, Kp = 1 but are read
 * from the header row when one is present, so a reordered feed
 * still parses. Rows shaped as objects ({ time_tag, Kp }) are also
 * accepted for robustness.
 */
export function parseKpResponse(json: unknown): SpaceWeatherReading | null {
  if (!Array.isArray(json) || json.length === 0) return null;

  let timeIdx = 0;
  let kpIdx = 1;
  const header = json[0];
  if (Array.isArray(header)) {
    const names = header.map((h) =>
      typeof h === "string" ? h.trim().toLowerCase() : ""
    );
    const t = names.indexOf("time_tag");
    const k = names.indexOf("kp");
    if (t >= 0) timeIdx = t;
    if (k >= 0) kpIdx = k;
  }

  return selectNewestReading(json, (row) => {
    if (Array.isArray(row)) {
      const value = toFiniteNumber(row[kpIdx]);
      if (value === null) return null;
      return { value, timeTag: toTimeTag(row[timeIdx]) };
    }
    if (isRecord(row)) {
      const value =
        toFiniteNumber(row.Kp) ??
        toFiniteNumber(row.kp) ??
        toFiniteNumber(row.kp_index);
      if (value === null) return null;
      return { value, timeTag: toTimeTag(row.time_tag) };
    }
    return null;
  });
}

/**
 * Parse the SWPC F10.7 product (array of { time_tag, flux }).
 * Returns the entry with the NEWEST time_tag whose flux is finite
 * (positionally last finite entry if no time tag parses), or null.
 */
export function parseF107Response(json: unknown): SpaceWeatherReading | null {
  if (!Array.isArray(json) || json.length === 0) return null;

  return selectNewestReading(json, (row) => {
    if (!isRecord(row)) return null;
    const value = toFiniteNumber(row.flux);
    if (value === null) return null;
    return { value, timeTag: toTimeTag(row.time_tag) };
  });
}

/* ------------------------------------------------------------
   Regime logic
   ------------------------------------------------------------ */

/**
 * NOAA G-scale from Kp:
 *   Kp < 5 → G0 (no storm)   5 ≤ Kp < 6 → G1 (minor)
 *   < 7 → G2 (moderate)      < 8 → G3 (strong)
 *   < 9 → G4 (severe)        ≥ 9 → G5 (extreme)
 * Non-finite input is treated as G0 so a bad value can never
 * light up a storm badge.
 */
export function kpToGScale(kp: number): GeomagneticScale {
  if (!Number.isFinite(kp)) return "G0";
  if (kp < 5) return "G0";
  if (kp < 6) return "G1";
  if (kp < 7) return "G2";
  if (kp < 8) return "G3";
  if (kp < 9) return "G4";
  return "G5";
}

/** NOAA's own descriptor for each G level. */
export const G_SCALE_DESCRIPTION: Record<GeomagneticScale, string> = {
  G0: "NO STORM",
  G1: "MINOR",
  G2: "MODERATE",
  G3: "STRONG",
  G4: "SEVERE",
  G5: "EXTREME",
};

/**
 * Base drag regime from F10.7 alone (sfu):
 *   < 100 LOW · < 150 MODERATE · < 200 ELEVATED · ≥ 200 HIGH
 * Non-finite input falls back to MODERATE (the climatological mean).
 */
export function f107BaseRegime(f107: number): Exclude<DragRegime, "UNKNOWN"> {
  if (!Number.isFinite(f107)) return "MODERATE";
  if (f107 < F107_LOW_MAX) return "LOW";
  if (f107 < F107_MODERATE_MAX) return "MODERATE";
  if (f107 < F107_ELEVATED_MAX) return "ELEVATED";
  return "HIGH";
}

/**
 * Combined drag regime:
 *   - both inputs null (or non-finite) → UNKNOWN
 *   - base from F10.7 (see f107BaseRegime); when F10.7 is missing
 *     the base is MODERATE
 *   - bumped ONE level (capped at HIGH) when Kp ≥ 5 (G1+ storm),
 *     because storm-time Joule heating raises LEO density on top
 *     of the EUV-driven background.
 */
export function dragRegime(f107: number | null, kp: number | null): DragRegime {
  const f = f107 !== null && Number.isFinite(f107) ? f107 : null;
  const k = kp !== null && Number.isFinite(kp) ? kp : null;
  if (f === null && k === null) return "UNKNOWN";

  const base: Exclude<DragRegime, "UNKNOWN"> =
    f === null ? "MODERATE" : f107BaseRegime(f);

  if (k !== null && k >= KP_STORM_THRESHOLD) {
    const idx = REGIME_ORDER.indexOf(base);
    const bumped = Math.min(idx + 1, REGIME_ORDER.length - 1);
    return REGIME_ORDER[bumped];
  }
  return base;
}

/** One-sentence operational meaning of each regime (shown verbatim in the UI). */
export const REGIME_EXPLANATION: Record<DragRegime, string> = {
  LOW: "Weak solar EUV heating keeps thermospheric density near solar-minimum levels, so LEO drag is light, orbital decay is slow, and TLE in-track error grows slowly between element-set updates.",
  MODERATE:
    "Thermospheric density is near its long-term mean, so LEO drag and decay rates are typical and TLE drag terms (B*) remain representative for several days after epoch.",
  ELEVATED:
    "Enhanced EUV flux and/or geomagnetic heating has expanded the thermosphere, raising LEO drag, accelerating decay below roughly 500 km, and inflating in-track TLE error faster than nominal.",
  HIGH: "A strongly heated thermosphere can push LEO drag to several times nominal, so low-perigee objects decay rapidly and TLE-based predictions degrade within hours of epoch.",
  UNKNOWN:
    "Live NOAA SWPC indices are unavailable, so the current thermospheric density and LEO drag environment cannot be characterised from this feed.",
};

/* ------------------------------------------------------------
   Status assembly (used by the route; kept here so it is testable)
   ------------------------------------------------------------ */

/**
 * Build the API payload from parsed readings + per-feed errors.
 * gScale is derived from kp; dragRegime from both.
 */
export function buildSpaceWeatherStatus(input: {
  fetchedAt: string;
  kp: SpaceWeatherReading | null;
  f107: SpaceWeatherReading | null;
  errors: { kp?: string; f107?: string };
}): SpaceWeatherStatus {
  const kpValue = input.kp ? input.kp.value : null;
  const f107Value = input.f107 ? input.f107.value : null;
  return {
    fetchedAt: input.fetchedAt,
    kp: input.kp,
    f107: input.f107,
    gScale: kpValue === null ? null : kpToGScale(kpValue),
    dragRegime: dragRegime(f107Value, kpValue),
    errors: input.errors,
  };
}

/* ------------------------------------------------------------
   Display helper — render an SWPC time tag (see parseTimeTagMs)
   as "YYYY-MM-DD HH:MM UTC"; fall back to the raw string when it
   does not parse, or "—" when blank.
   ------------------------------------------------------------ */

export function formatTimeTagUtc(timeTag: string | null | undefined): string {
  if (typeof timeTag !== "string") return "—";
  const raw = timeTag.trim();
  if (raw === "") return "—";

  const ms = parseTimeTagMs(raw);
  if (ms === null) return raw;
  const d = new Date(ms);

  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate()
  )} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
