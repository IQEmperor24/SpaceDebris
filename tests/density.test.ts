/* lib/density.ts — ORDEM-style altitude / inclination histograms.
   Half-open bins, Kessler-band accounting, class split, NaN safety. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAltitudeHistogram,
  buildInclinationHistogram,
  emptyBin,
  KESSLER_BAND_KM,
  makeBins,
  peakBin,
  type AltitudeHistogramInput,
  type InclinationHistogramInput,
} from "@/lib/density";

/** Row whose mean altitude is exactly `alt` (apoapsis = periapsis). */
const altRow = (alt: number | string, name = "PAYLOAD SAT"): AltitudeHistogramInput => ({
  APOAPSIS: String(alt),
  PERIAPSIS: String(alt),
  OBJECT_NAME: name,
});
const incRow = (inc: number | string, name = "PAYLOAD SAT"): InclinationHistogramInput => ({ INCLINATION: String(inc), OBJECT_NAME: name });
function binAt<T extends { from: number }>(h: { bins: T[] }, from: number): T {
  const b = h.bins.find((x) => x.from === from);
  assert.ok(b, `bin starting at ${from} exists`);
  return b;
}

test("default grids: 38 x 50 km bins over 100-2000 km, 36 x 5 deg bins over 0-180 deg", () => {
  const alt = buildAltitudeHistogram([]);
  assert.equal(alt.bins.length, 38);
  assert.deepEqual([alt.bins[0].from, alt.bins[0].to, alt.bins[37].from, alt.bins[37].to], [100, 150, 1950, 2000]);
  assert.equal(alt.total, 0);
  assert.equal(alt.peak, null);
  assert.equal(alt.bandShare, 0);
  const inc = buildInclinationHistogram([]);
  assert.equal(inc.bins.length, 36);
  assert.deepEqual([inc.bins[0].from, inc.bins[35].from, inc.bins[35].to], [0, 175, 180]);
});

test("altitude edges are half-open: 100 in, 2000 above, 99.99 below", () => {
  const h = buildAltitudeHistogram([altRow(100), altRow(2000), altRow(99.99)]);
  assert.equal(h.bins[0].count, 1);
  assert.equal(h.above, 1);
  assert.equal(h.below, 1);
  assert.equal(h.total, 1);
});

test("Kessler band 700-1000 km is half-open at both ends", () => {
  assert.deepEqual({ from: KESSLER_BAND_KM.from, to: KESSLER_BAND_KM.to }, { from: 700, to: 1000 });
  const low = buildAltitudeHistogram([altRow(699.99), altRow(700)]);
  assert.equal(binAt(low, 650).count, 1);
  assert.equal(binAt(low, 700).count, 1);
  assert.equal(low.bandCount, 1);
  assert.equal(low.bandShare, 0.5);
  const high = buildAltitudeHistogram([altRow(1000), altRow(999.99)]);
  assert.equal(binAt(high, 1000).count, 1);
  assert.equal(binAt(high, 950).count, 1);
  assert.equal(high.bandCount, 1);
});

test("mean altitude is (apoapsis + periapsis) / 2; non-numeric rows are skipped entirely", () => {
  const ecc = buildAltitudeHistogram([{ APOAPSIS: "900", PERIAPSIS: "700", OBJECT_NAME: "ECC" }]);
  assert.equal(binAt(ecc, 800).count, 1);
  const h = buildAltitudeHistogram([
    { APOAPSIS: "null", PERIAPSIS: "550", OBJECT_NAME: "X" },
    { APOAPSIS: "", PERIAPSIS: "", OBJECT_NAME: "Y" },
    { APOAPSIS: "abc", PERIAPSIS: "550", OBJECT_NAME: "Z" },
    altRow(550),
  ]);
  assert.equal(h.total, 1);
  assert.equal(h.below + h.above, 0);
  assert.equal(binAt(h, 550).count, 1);
});

test("class split: debris / payload / rocket body / unknown sum to the bin count", () => {
  const names = ["COSMOS 2251 DEB", "FENGYUN 1C DEB", "IRIDIUM 33", "CZ-2C R/B", "SL-8 R/B", "DELTA 1 AKM", "TBA - TO BE ASSIGNED", "UNKNOWN"];
  const b = binAt(buildAltitudeHistogram(names.map((n) => altRow(820, n))), 800);
  assert.deepEqual([b.count, b.debris, b.payload, b.rocketBody, b.unknown], [8, 2, 1, 3, 2]);
  assert.equal(b.debris + b.payload + b.rocketBody + b.unknown, b.count);
});

test("peak: highest count wins, the lower bin wins ties, null when empty", () => {
  const h = buildAltitudeHistogram([400, 400, 400, 800, 800, 800, 1200].map((a) => altRow(a)));
  assert.ok(h.peak);
  assert.equal(h.peak.from, 400);
  assert.equal(h.peak.count, 3);
  assert.equal(peakBin([]), null);
  assert.equal(peakBin([emptyBin(0, 1), emptyBin(1, 2)]), null);
  const bins = makeBins(0, 30, 10);
  bins[2].count = 5;
  bins[1].count = 7;
  assert.equal(peakBin(bins)?.from, 10);
});

test("band share = bandCount / total, and 0 when nothing is in range", () => {
  const h = buildAltitudeHistogram([750, 850, 450, 1500].map((a) => altRow(a)));
  assert.equal(h.bandCount, 2);
  assert.equal(h.bandShare, 0.5);
  const outside = buildAltitudeHistogram([altRow(2500), altRow(50)]);
  assert.equal(outside.total, 0);
  assert.equal(outside.bandShare, 0);
  assert.equal(outside.above, 1);
  assert.equal(outside.below, 1);
});

test("custom and degenerate grids: last bin clamps; invalid parameters give empty output", () => {
  const h = buildAltitudeHistogram([altRow(1995)], 100, 2000, 30);
  assert.equal(h.bins.length, 64);
  assert.deepEqual([h.bins[63].from, h.bins[63].to, h.bins[63].count], [1990, 2000, 1]);
  assert.deepEqual(makeBins(0, 10, 0), []);
  assert.deepEqual(makeBins(10, 0, 5), []);
  assert.deepEqual(makeBins(Number.NaN, 10, 5), []);
  const bad = buildAltitudeHistogram([altRow(500)], 100, 2000, -5);
  assert.equal(bad.bins.length, 0);
  assert.equal(bad.total, 0);
  assert.equal(bad.bandShare, 0);
});

test("inclination: 180 lands in the LAST bin, 5 starts the second, out-of-range skipped", () => {
  const h = buildInclinationHistogram([incRow(0), incRow(180), incRow(97.5), incRow("abc"), incRow(-1), incRow(181), incRow(51.6, "ISS (ZARYA)")]);
  assert.equal(h.bins[0].count, 1);
  assert.equal(h.bins[35].count, 1);
  assert.equal(binAt(h, 95).count, 1);
  assert.equal(binAt(h, 50).payload, 1);
  assert.equal(h.total, 4);
  const edges = buildInclinationHistogram([incRow(5), incRow(4.999)]);
  assert.equal(binAt(edges, 0).count, 1);
  assert.equal(binAt(edges, 5).count, 1);
  const wide = buildInclinationHistogram([incRow(98, "DEB A"), incRow(98.5, "SAT B R/B"), incRow(99, "SAT C")], 10);
  assert.equal(wide.bins.length, 18);
  const b = binAt(wide, 90);
  assert.deepEqual([b.count, b.debris, b.rocketBody, b.payload], [3, 1, 1, 1]);
});

test("inputs are never mutated and every call returns fresh bins", () => {
  const row = altRow(500);
  const snapshot = JSON.stringify(row);
  const a = buildAltitudeHistogram([row]);
  const b = buildAltitudeHistogram([row]);
  assert.equal(JSON.stringify(row), snapshot);
  assert.notEqual(a.bins, b.bins);
  assert.notEqual(a.bins[0], b.bins[0]);
});
