/* lib/spaceweather.ts — NOAA SWPC parsers, NOAA G-scale and the drag-regime
   heuristic, plus the decay inputs behind the Reentry Watch table.
   All fixtures are inline; the module is pure (no fetch). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as SW from "@/lib/spaceweather";
import { decayEstimate, tleElements } from "@/lib/orbital";

test("endpoints are the two public NOAA SWPC products", () => {
  assert.equal(SW.SWPC_KP_URL, "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json");
  assert.equal(SW.SWPC_F107_URL, "https://services.swpc.noaa.gov/json/f107_cm_flux.json");
});

const KP_HEADER = ["time_tag", "Kp", "a_running", "station_count"];

test("parseKpResponse picks the NEWEST time_tag, not the last row", () => {
  const ascending: unknown = [
    KP_HEADER,
    ["2026-10-09 21:00:00.000", "2.00", "7", "8"],
    ["2026-10-10 00:00:00.000", "2.67", "12", "8"],
    ["2026-10-10 03:00:00.000", "3.33", "18", "8"],
    ["2026-10-10 06:00:00.000", "", "", "0"],
  ];
  const newest = { value: 3.33, timeTag: "2026-10-10 03:00:00.000" };
  assert.deepEqual(SW.parseKpResponse(ascending), newest, "blank trailing Kp is skipped");
  const descending: unknown = [KP_HEADER, ["2026-10-10 03:00:00.000", "3.33"], ["2026-10-10 00:00:00.000", "2.67"], ["2026-10-09 21:00:00.000", "2.00"]];
  assert.deepEqual(SW.parseKpResponse(descending), newest);
  const shuffled: unknown = [["time_tag", "Kp"], ["2026-10-09 21:00:00.000", "2.00"], ["2026-10-10 03:00:00.000", "3.33"], ["2026-10-10 00:00:00.000", "2.67"]];
  assert.deepEqual(SW.parseKpResponse(shuffled), newest);
});

test("parsers: positional fallback, dated rows beat undated ones, ties go to the later row", () => {
  assert.deepEqual(SW.parseKpResponse([["time_tag", "Kp"], ["t1", "1.00"], ["t2", "2.00"], ["t3", ""]]), { value: 2, timeTag: "t2" });
  assert.deepEqual(SW.parseF107Response([{ flux: 101 }, { time_tag: "garbage", flux: 102 }]), { value: 102, timeTag: "garbage" });
  assert.deepEqual(
    SW.parseF107Response([{ time_tag: "2026-10-10T20:00:00", flux: 160 }, { time_tag: "n/a", flux: 120 }]),
    { value: 160, timeTag: "2026-10-10T20:00:00" }
  );
  assert.deepEqual(
    SW.parseKpResponse([["time_tag", "Kp"], ["2026-10-10 03:00:00.000", "3.00"], ["2026-10-10 03:00:00.000", "3.33"]]),
    { value: 3.33, timeTag: "2026-10-10 03:00:00.000" }
  );
  // A numeric time_tag cell must never masquerade as a far-future date.
  assert.deepEqual(
    SW.parseKpResponse([["time_tag", "Kp"], [12345, "9.00"], ["2026-10-10 03:00:00.000", "3.33"]]),
    { value: 3.33, timeTag: "2026-10-10 03:00:00.000" }
  );
});

test("parseKpResponse: header lookup, numeric cells, object rows, garbage", () => {
  assert.deepEqual(SW.parseKpResponse([["Kp", "time_tag", "a_running"], ["4.00", "2026-10-10 09:00:00.000", "27"]]), {
    value: 4,
    timeTag: "2026-10-10 09:00:00.000",
  });
  assert.deepEqual(SW.parseKpResponse([["time_tag", "Kp"], ["2026-10-10 12:00:00.000", 5.67]]), { value: 5.67, timeTag: "2026-10-10 12:00:00.000" });
  assert.deepEqual(SW.parseKpResponse([{ time_tag: "2026-10-10T12:00:00", Kp: "1.33" }]), { value: 1.33, timeTag: "2026-10-10T12:00:00" });
  for (const bad of [[KP_HEADER], [], null, "nope", { foo: 1 }]) assert.equal(SW.parseKpResponse(bad), null);
  assert.equal(SW.parseKpResponse([["time_tag", "Kp"], ["t", "NaN"], ["t2", "Infinity"], ["t3", "abc"]]), null, "never NaN / Infinity");
});

test("parseF107Response: newest finite flux, string or number; garbage -> null", () => {
  const ascending: unknown = [
    { time_tag: "2026-10-08T20:00:00", flux: 142.5 },
    { time_tag: "2026-10-09T20:00:00", flux: "151.2" },
    { time_tag: "2026-10-10T20:00:00", flux: null },
  ];
  assert.deepEqual(SW.parseF107Response(ascending), { value: 151.2, timeTag: "2026-10-09T20:00:00" });
  // Review regression: a newest-first feed used to return the month-old 120 sfu row.
  const descending: unknown = [
    { time_tag: "2026-10-10T20:00:00", flux: 162.9 },
    { time_tag: "2026-10-09T20:00:00", flux: 158.1 },
    { time_tag: "2026-09-11T20:00:00", flux: 120.0 },
  ];
  assert.deepEqual(SW.parseF107Response(descending), { value: 162.9, timeTag: "2026-10-10T20:00:00" });
  for (const bad of [[], undefined, [{ flux: "" }, { flux: "x" }], [[1, 2, 3]]]) assert.equal(SW.parseF107Response(bad), null);
  assert.deepEqual(SW.parseF107Response([{ flux: 99 }]), { value: 99, timeTag: "" });
});

test("kpToGScale follows the NOAA G-scale boundaries", () => {
  const cases: Array<[number, SW.GeomagneticScale]> = [
    [0, "G0"], [4.99, "G0"], [5, "G1"], [5.67, "G1"], [6, "G2"], [6.99, "G2"],
    [7, "G3"], [7.99, "G3"], [8, "G4"], [8.99, "G4"], [9, "G5"], [9.5, "G5"], [Number.NaN, "G0"],
  ];
  for (const [kp, g] of cases) assert.equal(SW.kpToGScale(kp), g, `Kp ${kp}`);
  for (const g of ["G0", "G1", "G2", "G3", "G4", "G5"] as const) assert.ok(SW.G_SCALE_DESCRIPTION[g].length > 0);
});

test("drag regime: F10.7 base level, a Kp >= 5 storm bumps one level, capped at HIGH", () => {
  const base: Array<[number, string]> = [[70, "LOW"], [99.9, "LOW"], [100, "MODERATE"], [149.9, "MODERATE"], [150, "ELEVATED"], [199.9, "ELEVATED"], [200, "HIGH"], [300, "HIGH"], [Number.NaN, "MODERATE"]];
  for (const [f107, regime] of base) assert.equal(SW.f107BaseRegime(f107), regime, `F10.7 ${f107}`);
  assert.equal(SW.dragRegime(null, null), "UNKNOWN");
  assert.equal(SW.dragRegime(Number.NaN, Number.NaN), "UNKNOWN");
  assert.equal(SW.dragRegime(80, 2), "LOW");
  assert.equal(SW.dragRegime(120, 2), "MODERATE");
  assert.equal(SW.dragRegime(170, 4.99), "ELEVATED");
  assert.equal(SW.dragRegime(230, 0), "HIGH");
  assert.equal(SW.dragRegime(80, null), "LOW");
  assert.equal(SW.dragRegime(80, 5), "MODERATE");
  assert.equal(SW.dragRegime(120, 5), "ELEVATED");
  assert.equal(SW.dragRegime(170, 7), "HIGH");
  assert.equal(SW.dragRegime(230, 9), "HIGH");
  assert.equal(SW.dragRegime(null, 2), "MODERATE");
  assert.equal(SW.dragRegime(null, 5), "ELEVATED");
  for (const r of ["LOW", "MODERATE", "ELEVATED", "HIGH", "UNKNOWN"] as const) {
    assert.ok(SW.REGIME_EXPLANATION[r].length > 40 && /[.!]$/.test(SW.REGIME_EXPLANATION[r].trim()));
  }
});

test("buildSpaceWeatherStatus derives the G-scale and regime, and keeps partial errors", () => {
  const s = SW.buildSpaceWeatherStatus({
    fetchedAt: "2026-10-10T12:00:00.000Z",
    kp: { value: 6.33, timeTag: "2026-10-10 09:00:00.000" },
    f107: { value: 160, timeTag: "2026-10-09T20:00:00" },
    errors: {},
  });
  assert.equal(s.gScale, "G2");
  assert.equal(s.dragRegime, "HIGH");
  const partial = SW.buildSpaceWeatherStatus({ fetchedAt: "x", kp: null, f107: { value: 90, timeTag: "" }, errors: { kp: "HTTP 503" } });
  assert.equal(partial.gScale, null);
  assert.equal(partial.dragRegime, "LOW");
  assert.equal(partial.errors.kp, "HTTP 503");
  const none = SW.buildSpaceWeatherStatus({ fetchedAt: "x", kp: null, f107: null, errors: { kp: "a", f107: "b" } });
  assert.equal(none.dragRegime, "UNKNOWN");
});

test("time tags: both SWPC spellings are the same UTC instant; garbage is null or a dash", () => {
  const expected = Date.UTC(2026, 9, 10, 15, 0, 0);
  for (const tag of ["2026-10-10 15:00:00.000", "2026-10-10T15:00:00", "2026-10-10T15:00:00Z", "2026-10-10T15:00:00+00:00", "  2026-10-10 15:00:00.000  ", "2026-10-10T10:00:00-05:00"]) {
    assert.equal(SW.parseTimeTagMs(tag), expected, tag);
  }
  assert.equal(SW.parseTimeTagMs("2026-10-10"), Date.UTC(2026, 9, 10));
  for (const bad of ["", "   ", null, undefined, "garbage", "12345", "2026-13-45 99:00:00"]) assert.equal(SW.parseTimeTagMs(bad), null);
  assert.equal(SW.formatTimeTagUtc("2026-10-10 15:00:00.000"), "2026-10-10 15:00 UTC");
  assert.equal(SW.formatTimeTagUtc("2026-10-10T20:00:00Z"), "2026-10-10 20:00 UTC");
  assert.equal(SW.formatTimeTagUtc(""), "—");
  assert.equal(SW.formatTimeTagUtc(null), "—");
  assert.equal(SW.formatTimeTagUtc("not a date"), "not a date");
});

test("toFiniteNumber only ever returns a finite number or null", () => {
  assert.equal(SW.toFiniteNumber("3.33"), 3.33);
  assert.equal(SW.toFiniteNumber(" 7 "), 7);
  assert.equal(SW.toFiniteNumber(4), 4);
  for (const bad of ["", "Kp", null, undefined, Infinity, {}]) assert.equal(SW.toFiniteNumber(bad), null);
});

/* Reentry Watch inputs: tleElements -> decayEstimate on low objects. */
const lowObject = (norad: string, ndot: string, ecc: string, meanAnomaly: string, meanMotion: string) => ({
  OBJECT_NAME: `TEST ${norad}`,
  NORAD_CAT_ID: norad,
  TLE_LINE1: `1 ${norad}U 24001A   24001.50000000 ${ndot}  00000-0  50000-2 0  9990`,
  TLE_LINE2: `2 ${norad}  51.6400 208.9163 ${ecc}  69.9862 ${meanAnomaly} ${meanMotion}  1000`,
});

test("reentry inputs: fast decayer is IMMINENT, sub-120 km is lifetime 0, corrupt perigee is detectable", () => {
  const fast = tleElements(lowObject("99999", " .01000000", "0010000", " 25.2906", "16.25000000"));
  assert.ok(fast);
  assert.ok(fast.perigeeKm > 100 && fast.perigeeKm < 300, `perigee ${fast.perigeeKm}`);
  const d = decayEstimate(fast);
  assert.ok(d.decayKmPerDay > 0);
  assert.ok(d.estimatedLifetimeDays !== null && d.estimatedLifetimeDays > 0 && d.estimatedLifetimeDays < 30);

  const finalRevs = tleElements(lowObject("55555", " .05000000", "0001000", " 25.2906", "16.60000000"));
  assert.ok(finalRevs);
  assert.equal(decayEstimate(finalRevs).estimatedLifetimeDays, 0, "mean altitude <= 120 km -> lifetime 0");

  // e = 0.05 at 16 rev/day parses (epoch at apogee) but has a NEGATIVE perigee:
  // the Reentry Watch must filter on 0 < perigee < 300 km, not trust the TLE.
  const corrupt = tleElements(lowObject("66666", " .00500000", "0500000", "180.0000", "16.00000000"));
  assert.ok(corrupt);
  assert.ok(corrupt.perigeeKm < 0, `perigee ${corrupt.perigeeKm}`);
});
