/* lib/iss.ts — ISS TOPO console: JSC pass prediction, ground track and
   CDM grading against the NASA ISS thresholds (RED Pc >= 1e-4, YELLOW >= 1e-5). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as O from "@/lib/orbital";
import * as I from "@/lib/iss";
import type { SpaceTrackCDM } from "@/lib/spacetrack";
import { ISS_EPOCH as T0, ISS_L1, ISS_L2 } from "./fixtures";

const satrec = O.parseTle(ISS_L1, ISS_L2);
assert.ok(satrec, "ISS TLE must parse");
const HOUR_MS = 3_600_000;

const elevationAt = (ms: number): number => {
  const sv = O.propagateAt(satrec, new Date(ms));
  assert.ok(sv);
  return O.lookAngles(O.JSC_SITE, sv.position, new Date(ms)).elevationDeg;
};

test("predictPasses: >= 2 JSC passes in 24 h with refined AOS/LOS at the 10 deg mask", () => {
  const passes = I.predictPasses(satrec, O.JSC_SITE, T0, 24);
  assert.ok(passes.length >= 2, `got ${passes.length} passes`);
  for (const p of passes) {
    const aos = Date.parse(p.aos);
    const los = Date.parse(p.los);
    const max = Date.parse(p.maxElevationTime);
    assert.ok(aos < max && max < los, `AOS < max < LOS: ${p.aos} ${p.maxElevationTime} ${p.los}`);
    assert.ok(p.durationSeconds >= 120 && p.durationSeconds <= 720, `duration ${p.durationSeconds}`);
    assert.ok(Math.abs(p.durationSeconds - (los - aos) / 1000) < 1e-6);
    assert.ok(p.maxElevationDeg >= 10 && p.maxElevationDeg <= 90);
    assert.ok(p.aosAzimuthDeg >= 0 && p.aosAzimuthDeg < 360 && p.losAzimuthDeg >= 0 && p.losAzimuthDeg < 360);
    assert.ok(Math.abs(elevationAt(aos) - 10) < 0.05, "AOS sits on the mask");
    assert.ok(Math.abs(elevationAt(los) - 10) < 0.05, "LOS sits on the mask");
    assert.ok(aos <= T0.getTime() + 24 * HOUR_MS);
  }
  for (let i = 1; i < passes.length; i++) {
    assert.ok(Date.parse(passes[i].aos) >= Date.parse(passes[i - 1].los), "chronological, no overlap");
  }
});

test("predictPasses: a pass in progress at start is reported with its true AOS", () => {
  const first = I.predictPasses(satrec, O.JSC_SITE, T0, 24)[0];
  const mid = new Date((Date.parse(first.aos) + Date.parse(first.los)) / 2);
  const again = I.predictPasses(satrec, O.JSC_SITE, mid, 24)[0];
  assert.ok(Date.parse(again.aos) < mid.getTime() && Date.parse(again.los) > mid.getTime());
  assert.ok(Math.abs(Date.parse(again.aos) - Date.parse(first.aos)) < 1500);
  assert.ok(Math.abs(Date.parse(again.los) - Date.parse(first.los)) < 1500);
});

test("predictPasses: joining AFTER culmination keeps the true max elevation (regression)", () => {
  const first = I.predictPasses(satrec, O.JSC_SITE, T0, 24)[0];
  const maxMs = Date.parse(first.maxElevationTime);
  for (const offsetS of [60, 120]) {
    const start = new Date(maxMs + offsetS * 1000);
    const p = I.predictPasses(satrec, O.JSC_SITE, start, 24)[0];
    assert.ok(Math.abs(p.maxElevationDeg - first.maxElevationDeg) < 0.05, `max el decayed at +${offsetS}s`);
    assert.ok(Math.abs(Date.parse(p.maxElevationTime) - maxMs) <= 2000);
    assert.ok(Date.parse(p.maxElevationTime) < start.getTime(), "max lies in the backward leg");
  }
});

test("predictPasses: a tail ending within the first step is skipped; bad input never throws", () => {
  const first = I.predictPasses(satrec, O.JSC_SITE, T0, 24)[0];
  const nearEnd = new Date(Date.parse(first.los) - 5000);
  const again = I.predictPasses(satrec, O.JSC_SITE, nearEnd, 24);
  assert.ok(Date.parse(again[0].aos) > nearEnd.getTime());
  assert.deepEqual(I.predictPasses(satrec, O.JSC_SITE, new Date(Number.NaN), 24), []);
  assert.ok(Array.isArray(I.predictPasses(satrec, O.JSC_SITE, T0, 0.0001)));
});

test("groundTrack: +-46 min, geodetic latitude bound, seam-safe split", () => {
  const pts = I.groundTrack(satrec, T0);
  assert.ok(pts.length >= 91 && pts.length <= 93, `${pts.length} points`);
  // Geodetic latitude can exceed the inclination by ~0.19 deg on the ellipsoid.
  let maxAbsLat = 0;
  for (const p of pts) {
    assert.ok(Number.isFinite(p.latitudeDeg) && Number.isFinite(p.longitudeDeg));
    assert.ok(Math.abs(p.latitudeDeg) <= 51.84 && p.longitudeDeg >= -180 && p.longitudeDeg <= 180);
    maxAbsLat = Math.max(maxAbsLat, Math.abs(p.latitudeDeg));
  }
  assert.ok(maxAbsLat > 51.0, "the track reaches the inclination band");
  assert.equal(pts[0].minutesFromCenter, -46);
  assert.equal(pts[pts.length - 1].minutesFromCenter, 46);
  const centre = pts.find((p) => p.minutesFromCenter === 0);
  assert.ok(centre);
  assert.ok(Math.abs(centre.latitudeDeg - 51.46) < 0.01 && Math.abs(centre.longitudeDeg - 27.13) < 0.01);

  const segs = I.splitTrackAtSeam(pts);
  assert.equal(segs.reduce((n, s) => n + s.length, 0), pts.length);
  for (const s of segs) for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i].longitudeDeg - s[i - 1].longitudeDeg) <= 180);
  assert.deepEqual(I.splitTrackAtSeam([]), []);
  const synthetic = [170, 179, -179, -170].map((longitudeDeg) => ({ longitudeDeg }));
  assert.equal(I.splitTrackAtSeam(synthetic).length, 2);
});

function cdm(partial: Partial<SpaceTrackCDM>): SpaceTrackCDM {
  return {
    CDM_ID: "1",
    CREATED: "2024-01-01 00:00:00",
    TCA: "2024-01-02T00:00:00.000",
    MIN_RNG: "1.234",
    PC: "0",
    SAT_1_ID: "25544",
    SAT_1_NAME: "ISS (ZARYA)",
    SAT_2_ID: "99999",
    SAT_2_NAME: "COSMOS 1408 DEB",
    ...partial,
  };
}

test("assessIssCdm: thresholds are inclusive at exactly 1e-4 and 1e-5", () => {
  const level = (PC: string) => I.assessIssCdm(cdm({ PC })).level;
  assert.equal(level("1e-4"), "RED");
  assert.equal(level("0.0001"), "RED");
  assert.equal(level("0.00009999"), "YELLOW");
  assert.equal(level("1e-5"), "YELLOW");
  assert.equal(level("9.99e-6"), "GREEN");
  assert.equal(level("0"), "GREEN");
  assert.equal(level(""), "GREEN");
  assert.equal(level("null"), "GREEN");
  assert.equal(I.assessIssCdm(cdm({ PC: "null" })).pc, null);
  assert.equal(I.assessIssCdm(cdm({ MIN_RNG: "abc" })).missKm, null);
  assert.equal(I.assessIssCdm(cdm({ MIN_RNG: "0.750" })).missKm, 0.75);
});

test("assessIssCdm / isIssCdm: the other object is whichever side is not 25544", () => {
  const a = I.assessIssCdm(cdm({}));
  assert.equal(a.otherId, "99999");
  assert.equal(a.otherName, "COSMOS 1408 DEB");
  const b = I.assessIssCdm(cdm({ SAT_1_ID: "48274", SAT_1_NAME: "STARLINK-9999", SAT_2_ID: " 25544", SAT_2_NAME: "ISS (ZARYA)" }));
  assert.equal(b.otherId, "48274");
  assert.equal(b.otherName, "STARLINK-9999");
  assert.equal(I.assessIssCdm(cdm({ SAT_2_NAME: "   " })).otherName, "NORAD 99999");
  assert.equal(I.isIssCdm(cdm({ SAT_1_ID: " 25544" })), true);
  assert.equal(I.isIssCdm(cdm({ SAT_1_ID: "11111", SAT_2_ID: "25544 " })), true);
  assert.equal(I.isIssCdm(cdm({ SAT_1_ID: "11111", SAT_2_ID: "22222" })), false);
  assert.equal(I.isIssCdm(cdm({ SAT_1_ID: "255440", SAT_2_ID: "22222" })), false);
});

test("worst level, TCA sort and zone-less Space-Track timestamps (UTC)", () => {
  assert.equal(I.worstIssCaLevel([]), "GREEN");
  assert.equal(I.worstIssCaLevel(["GREEN", "YELLOW"]), "YELLOW");
  assert.equal(I.worstIssCaLevel(["YELLOW", "RED", "GREEN"]), "RED");
  const sorted = I.sortCdmsByTca([
    cdm({ CDM_ID: "b", TCA: "2024-01-03T00:00:00.000" }),
    cdm({ CDM_ID: "x", TCA: "garbage" }),
    cdm({ CDM_ID: "a", TCA: "2024-01-02T00:00:00.000" }),
  ]);
  assert.deepEqual(sorted.map((c) => c.CDM_ID), ["a", "b", "x"]);
  const jan2 = Date.UTC(2024, 0, 2);
  assert.equal(I.parseUtcTimestamp("2024-01-02T00:00:00.000"), jan2);
  assert.equal(I.parseUtcTimestamp("2024-01-02 00:00:00"), jan2);
  assert.equal(I.parseUtcTimestamp("2024-01-02T00:00:00Z"), jan2);
  assert.equal(I.parseUtcTimestamp("2024-01-02T01:00:00+01:00"), jan2);
  assert.equal(I.parseUtcTimestamp("garbage"), null);
  assert.equal(I.parseUtcTimestamp(""), null);
  assert.equal(I.parseUtcTimestamp(undefined), null);
});

test("formatters never render NaN", () => {
  const compass: Array<[number, string]> = [[0, "N"], [22, "N"], [23, "NE"], [90, "E"], [135, "SE"], [180, "S"], [225, "SW"], [270, "W"], [312, "NW"], [359, "N"], [-90, "W"], [Number.NaN, "N"]];
  for (const [az, point] of compass) assert.equal(I.compassPoint(az), point, `azimuth ${az}`);
  assert.equal(I.formatLatitude(51.4607), "51.46° N");
  assert.equal(I.formatLatitude(-12), "12.00° S");
  assert.equal(I.formatLongitude(27.1331), "27.13° E");
  assert.equal(I.formatLongitude(-95.09), "95.09° W");
  assert.equal(I.formatLatitude(Number.NaN), "—");
  assert.equal(I.formatPc(null), "n/a");
  assert.equal(I.formatPc(3.21e-5), "3.2e-5");
  assert.equal(I.formatPcThreshold(O.ISS_PC_RED_THRESHOLD), "1e-4");
  assert.equal(I.formatPcThreshold(O.ISS_PC_YELLOW_THRESHOLD), "1e-5");
  assert.equal(I.tleAgeHours(new Date("2024-01-01T00:00:00Z"), Date.parse("2024-01-01T03:12:00Z")), 3.2);
  assert.equal(I.tleAgeHours(new Date(Number.NaN), 0), null);
});
