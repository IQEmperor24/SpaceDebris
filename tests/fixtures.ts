/* Shared fixtures for the node:test suite (not itself a test file).
   The ISS element set is an ISS-like SYNTHETIC TLE (NORAD 25544 format,
   51.64 deg, ~420 km, epoch 2024-01-01 12:00 UTC). Its checksum digits are
   not valid, which satellite.js does not check. Other synthetic objects are
   derived from it by editing fixed-width TLE columns so every derived line
   stays parseable. */
import assert from "node:assert/strict";
import type { SpaceTrackTLE } from "@/lib/spacetrack";

export const ISS_L1 = "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993";
export const ISS_L2 = "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.49560532 25002";
/** Epoch of the ISS fixture. */
export const ISS_EPOCH = new Date("2024-01-01T12:00:00Z");

/** A Space-Track gp row. Space-Track returns every field as a STRING. */
export function gpRow(partial: Partial<SpaceTrackTLE> = {}): SpaceTrackTLE {
  return {
    OBJECT_NAME: "",
    OBJECT_ID: "",
    NORAD_CAT_ID: "",
    EPOCH: "",
    TLE_LINE1: "",
    TLE_LINE2: "",
    INCLINATION: "",
    RA_OF_ASC_NODE: "",
    ECCENTRICITY: "",
    ARG_OF_PERICENTER: "",
    MEAN_ANOMALY: "",
    MEAN_MOTION: "",
    SEMIMAJOR_AXIS: "",
    PERIOD: "",
    APOAPSIS: "",
    PERIAPSIS: "",
    ...partial,
  };
}

/** gp row built from a name, NORAD id and two TLE lines. */
export function tleRow(name: string, norad: string, l1: string, l2: string): SpaceTrackTLE {
  return gpRow({ OBJECT_NAME: name, NORAD_CAT_ID: norad, TLE_LINE1: l1, TLE_LINE2: l2 });
}

/** Replace a fixed-width column span (1-indexed, inclusive) in a TLE line. */
export function setCols(line: string, startCol: number, endCol: number, value: string): string {
  const width = endCol - startCol + 1;
  assert.equal(value.length, width, `field "${value}" must be ${width} chars`);
  const out = line.slice(0, startCol - 1) + value + line.slice(endCol);
  assert.equal(out.length, line.length, "TLE line length must be preserved");
  return out;
}

/** Replace the NORAD id (cols 3-7) in both lines. */
export function setNorad(l1: string, l2: string, norad: string): [string, string] {
  const id = norad.padStart(5, "0");
  return [setCols(l1, 3, 7, id), setCols(l2, 3, 7, id)];
}

/** Format an angle for an 8-wide TLE field (e.g. RAAN, inclination, mean anomaly). */
export function angleField(deg: number): string {
  return deg.toFixed(4).padStart(8, " ");
}

/* ---------- Synthetic catalogs (built from orbital elements) ---------- */

function field(v: number, width: number, decimals: number): string {
  const s = v.toFixed(decimals);
  assert.ok(s.length <= width, `TLE field overflow: ${s} > ${width} chars`);
  return s.padStart(width, " ");
}

/** TLE epoch field "YYDDD.DDDDDDDD" for a Date. */
export function tleEpochField(date: Date): string {
  const y = date.getUTCFullYear();
  const doy = (date.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1;
  return `${String(y % 100).padStart(2, "0")}${doy.toFixed(8).padStart(12, "0")}`;
}

export interface SynthElements {
  norad: number;
  epoch: Date;
  altKm: number;
  incDeg: number;
  raanDeg: number;
  maDeg: number;
  ecc?: number;
  argpDeg?: number;
}

/** Fixed-width TLE lines for a near-circular orbit (satellite.js does not verify checksums). */
export function synthLines(e: SynthElements): [string, string] {
  const MU = 398600.4418;
  const a = 6378.137 + e.altKm;
  const revPerDay = (Math.sqrt(MU / (a * a * a)) * 86400) / (2 * Math.PI);
  const id = String(e.norad).padStart(5, "0");
  const deg360 = (d: number): number => ((d % 360) + 360) % 360;
  const ecc = Math.round((e.ecc ?? 0.0001) * 1e7).toString().padStart(7, "0");
  const l1 = `1 ${id}U 24001A   ${tleEpochField(e.epoch)}  .00000000  00000-0  10000-4 0  9990`;
  const l2 =
    `2 ${id} ${field(e.incDeg, 8, 4)} ${field(deg360(e.raanDeg), 8, 4)} ${ecc} ` +
    `${field(e.argpDeg ?? 0, 8, 4)} ${field(deg360(e.maDeg), 8, 4)} ${field(revPerDay, 11, 8)}    10`;
  assert.equal(l1.length, 69);
  assert.equal(l2.length, 69);
  return [l1, l2];
}

/** Deterministic PRNG (mulberry32) so synthetic catalogs are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n synthetic gp rows, altitudes uniform in [altLo, altHi], Starlink-like inclinations. */
export function synthCatalog(n: number, epoch: Date, altLo: number, altHi: number, seed = 1): SpaceTrackTLE[] {
  const r = rng(seed);
  const out: SpaceTrackTLE[] = [];
  for (let i = 0; i < n; i++) {
    const alt = altLo + (altHi - altLo) * r();
    const inc = [53, 53.2, 43, 70, 97.6, 51.64, 33][i % 7] + (r() - 0.5) * 0.4;
    const [l1, l2] = synthLines({ norad: 70000 + i, epoch, altKm: alt, incDeg: inc, raanDeg: 360 * r(), maDeg: 360 * r() });
    out.push(
      gpRow({ OBJECT_NAME: `SYNTH-${i}`, NORAD_CAT_ID: String(70000 + i), TLE_LINE1: l1, TLE_LINE2: l2, PERIAPSIS: (alt - 0.7).toFixed(3), APOAPSIS: (alt + 0.7).toFixed(3) })
    );
  }
  return out;
}
