/* lib/starlink.ts — Starlink constellation monitor: public FCC shell table,
   per-object phase from ONE element set, and per-shell crossing exposure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "@/lib/starlink";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { ISS_L1, ISS_L2, gpRow } from "./fixtures";

const mk = (name: string, apo: number | string, peri: number | string, inc: number | string, id = "1", l1 = "", l2 = ""): SpaceTrackTLE =>
  gpRow({ OBJECT_NAME: name, NORAD_CAT_ID: id, TLE_LINE1: l1, TLE_LINE2: l2, INCLINATION: String(inc), APOAPSIS: String(apo), PERIAPSIS: String(peri) });

function shell(r: S.StarlinkReport, id: string): S.ShellReport {
  const s = r.shells.find((x) => x.shell.id === id);
  assert.ok(s, `shell ${id} present`);
  return s;
}

test("shell table: the 7 public FCC shells (Gen1 + Gen2)", () => {
  assert.equal(S.STARLINK_SHELLS.length, 7);
  assert.equal(new Set(S.STARLINK_SHELLS.map((s) => s.id)).size, 7);
  const at = (a: number, i: number) => S.STARLINK_SHELLS.find((s) => s.altitudeKm === a && s.inclinationDeg === i);
  assert.equal(at(550, 53.0)?.authorized, 1584);
  assert.equal(at(540, 53.2)?.authorized, 1584);
  assert.equal(at(570, 70.0)?.authorized, 720);
  assert.equal(at(560, 97.6)?.authorized, 520);
  for (const [a, i] of [[525, 53.0], [530, 43.0], [535, 33.0]] as const) {
    const s = at(a, i);
    assert.ok(s);
    assert.equal(s.generation, "Gen2");
    assert.equal(s.authorized, null, "per-shell Gen2 split is not claimed");
  }
  assert.equal(S.GEN2_AUTHORIZED_TOTAL, 7500);
  assert.equal(S.GEN1_AUTHORIZED_TOTAL, 1584 + 1584 + 720 + 520);
});

test("labels and lookups", () => {
  const s550 = S.shellById("G1-550");
  assert.ok(s550);
  assert.equal(s550.label, "550 km · 53.0°");
  assert.equal(S.shellShortLabel(s550), "550 · 53°");
  const s540 = S.shellById("G1-540");
  assert.ok(s540);
  assert.equal(S.shellShortLabel(s540), "540 · 53.2°");
  assert.equal(S.shellById(null), null);
  assert.equal(S.shellById("nope"), null);
});

test("isStarlinkName matches the catalog naming convention only", () => {
  for (const yes of ["STARLINK-1234", "starlink-30001", "  STARLINK-5"]) assert.equal(S.isStarlinkName(yes), true, yes);
  for (const no of ["ONEWEB-0012", "COSMOS 2251 DEB", "NOT STARLINK", "", null, undefined]) assert.equal(S.isStarlinkName(no), false, String(no));
});

test("classification: operational shells, Gen2 shells, transit, deorbit, unassigned", () => {
  const op = S.classifyStarlink(mk("STARLINK-1001", 549, 547, 53.1, "44000"));
  assert.ok(op);
  assert.deepEqual([op.phase, op.shellId, op.altitudeKm, op.inclinationDeg, op.noradId], ["OPERATIONAL", "G1-550", 548, 53.1, "44000"]);
  assert.equal(op.ndotHalfRevPerDay2, null, "empty TLE lines -> null n-dot");
  assert.equal(S.classifyStarlink(mk("STARLINK-2001", 541, 539, 53.2))?.shellId, "G1-540");
  assert.equal(S.classifyStarlink(mk("STARLINK-3", 531, 529, 43.0))?.shellId, "G2-530");
  assert.equal(S.classifyStarlink(mk("STARLINK-4", 536, 534, 33.0))?.shellId, "G2-535");
  assert.equal(S.classifyStarlink(mk("STARLINK-5", 524, 522, 53.0))?.shellId, "G2-525");

  const raising = S.classifyStarlink(mk("STARLINK-1002", 481, 479, 53.0));
  assert.deepEqual([raising?.phase, raising?.shellId], ["ORBIT RAISING / LOWERING", "G2-525"]);
  const above = S.classifyStarlink(mk("STARLINK-1005", 621, 619, 43.0));
  assert.deepEqual([above?.phase, above?.shellId], ["ORBIT RAISING / LOWERING", "G2-530"]);
  const deorbit = S.classifyStarlink(mk("STARLINK-1003", 260, 240, 53));
  assert.equal(deorbit?.phase, "DEORBITING");
  assert.notEqual(deorbit?.shellId, null);
  const unassigned = S.classifyStarlink(mk("STARLINK-1004", 601, 599, 87));
  assert.deepEqual([unassigned?.phase, unassigned?.shellId], ["UNASSIGNED", null]);
});

test("shell matching tolerances are inclusive (+-1.5 deg, +-25 km); deorbit below 300 km", () => {
  assert.equal(S.SHELL_MATCH_INC_DEG, 1.5);
  assert.equal(S.SHELL_MATCH_ALT_KM, 25);
  assert.equal(S.DEORBIT_ALTITUDE_KM, 300);
  assert.equal(S.matchStarlinkShell(575, 54.5).phase, "OPERATIONAL");
  assert.equal(S.matchStarlinkShell(575, 54.5).shell?.id, "G1-550");
  assert.equal(S.matchStarlinkShell(545, 31.5).shell?.id, "G2-535");
  assert.equal(S.matchStarlinkShell(545, 31.4).phase, "UNASSIGNED");
  assert.equal(S.matchStarlinkShell(504, 33).phase, "ORBIT RAISING / LOWERING");
  assert.equal(S.matchStarlinkShell(299.9, 33).phase, "DEORBITING");
  assert.equal(S.matchStarlinkShell(300, 33).phase, "ORBIT RAISING / LOWERING");
  assert.equal(S.matchStarlinkShell(Number.NaN, 53).phase, "UNASSIGNED");
});

test("n-dot/2 is parsed from TLE line 1 cols 34-43, null when unparseable", () => {
  const o = S.classifyStarlink(mk("STARLINK-1006", 549, 547, 53.0, "25544", ISS_L1, ISS_L2));
  assert.ok(o && o.ndotHalfRevPerDay2 !== null);
  assert.ok(Math.abs(o.ndotHalfRevPerDay2 - 0.00016717) < 1e-12);
  const bad = ISS_L1.substring(0, 33) + "  xxxxxxxx" + ISS_L1.substring(43);
  assert.equal(bad.length, ISS_L1.length);
  assert.equal(S.classifyStarlink(mk("STARLINK-1007", 549, 547, 53.0, "25544", bad, ISS_L2))?.ndotHalfRevPerDay2, null);
});

test("non-Starlink and invalid rows are rejected", () => {
  assert.equal(S.classifyStarlink(mk("ONEWEB-0001", 1201, 1199, 87.9)), null);
  assert.equal(S.classifyStarlink(mk("STARLINK-9", "", "", 53)), null);
  assert.equal(S.classifyStarlink(mk("STARLINK-9", 550, 548, "abc")), null);
  assert.equal(S.classifyStarlink(mk("STARLINK-9", -10, -20, 53)), null);
  assert.equal(S.classifyStarlink(mk("STARLINK-9", 550, 548, 181)), null);
});

test("report: phase counts, per-shell statistics and crossing exposure", () => {
  const r = S.buildStarlinkReport([
    mk("STARLINK-1", 549, 547, 53.1, "1"),
    mk("STARLINK-2", 553, 551, 53.0, "2"),
    mk("STARLINK-3", 481, 479, 53.0, "3"),
    mk("STARLINK-4", 260, 240, 53.0, "4"),
    mk("STARLINK-5", 601, 599, 87.0, "5"),
    mk("STARLINK-6", "", "", 53.0, "6"),
    mk("ONEWEB-0001", 1201, 1199, 87.9, "7"),
    mk("COSMOS 2251 DEB", 560, 540, 74.0, "8"),
    mk("FALCON 9 R/B", 900, 200, 28.5, "9"),
    mk("TBA - TO BE ASSIGNED", 545, 545, 50.0, "10"),
    mk("ISS (ZARYA)", 422, 418, 51.6, "11"),
  ]);
  assert.deepEqual([r.sampleSize, r.starlinkTotal, r.skippedInvalid], [11, 5, 1]);
  assert.deepEqual([r.operational, r.transit, r.deorbiting, r.unassigned], [2, 1, 1, 1]);
  assert.ok(Math.abs(r.shareOfSample - 5 / 11) < 1e-12);
  assert.equal(r.crossingBandKm, S.DEFAULT_CROSSING_BAND_KM);
  assert.equal(r.objects.length, 5);

  const s550 = shell(r, "G1-550");
  assert.deepEqual([s550.operational, s550.transit, s550.meanAltitudeKm, s550.altitudeSpreadKm], [2, 0, 550, 2]);
  const s525 = shell(r, "G2-525");
  assert.deepEqual([s525.transit, s525.operational, s525.meanAltitudeKm, s525.altitudeSpreadKm], [1, 0, null, null]);
  // 540-560 km debris crosses 550 and 540; the 200 x 900 km rocket body crosses everything;
  // the TBA object at 545 counts as unknown; the ISS at 420 km crosses nothing.
  assert.deepEqual([s550.crossing.debris, s550.crossing.rocketBody, s550.crossing.unknown, s550.crossing.payload, s550.crossing.total], [1, 1, 1, 0, 3]);
  assert.equal(shell(r, "G1-540").crossing.debris, 1);
  const s570 = shell(r, "G1-570");
  assert.deepEqual([s570.crossing.debris, s570.crossing.unknown, s570.crossing.total], [1, 0, 2]);
  for (const s of r.shells) {
    const c = s.crossing;
    assert.equal(c.total, c.debris + c.rocketBody + c.payload + c.unknown, "Starlink objects never count as crossers");
  }
});

test("crossing band: edges, custom band, swapped apsides, invalid band falls back", () => {
  const deb = mk("FENGYUN 1C DEB", 560, 540, 98.8);
  const r0 = S.buildStarlinkReport([deb], 0);
  assert.equal(shell(r0, "G1-550").crossing.debris, 1);
  assert.equal(shell(r0, "G1-540").crossing.debris, 1);
  assert.equal(shell(r0, "G2-535").crossing.debris, 0);
  assert.equal(shell(r0, "G1-570").crossing.debris, 0);
  const r15 = S.buildStarlinkReport([deb]);
  assert.equal(shell(r15, "G2-525").crossing.debris, 1);
  assert.equal(shell(r15, "G1-570").crossing.debris, 1);
  assert.equal(shell(S.buildStarlinkReport([mk("X DEB", 540, 560, 98.8)], 0), "G1-550").crossing.debris, 1);
  assert.equal(S.buildStarlinkReport([deb], Number.NaN).crossingBandKm, 15);
  assert.equal(S.buildStarlinkReport([deb], -5).crossingBandKm, 15);
  const bad = S.buildStarlinkReport([mk("Y DEB", "", "x", 98.8)]);
  assert.equal(bad.shells.reduce((a, s) => a + s.crossing.total, 0), 0);
});

test("empty and malformed samples are safe", () => {
  const r = S.buildStarlinkReport([]);
  assert.deepEqual([r.starlinkTotal, r.shareOfSample, r.shells.length], [0, 0, 7]);
  for (const s of r.shells) assert.deepEqual([s.operational, s.meanAltitudeKm, s.crossing.total], [0, null, 0]);
  assert.equal(S.buildStarlinkReport(null as unknown as SpaceTrackTLE[]).sampleSize, 0);
  const holes = S.buildStarlinkReport([null, undefined, mk("STARLINK-1", 549, 547, 53)] as unknown as SpaceTrackTLE[]);
  assert.equal(holes.starlinkTotal, 1);
  assert.ok(Math.abs(holes.shareOfSample - 1 / 3) < 1e-12);
});

test("a realistic 2,000-row sample never produces NaN", () => {
  const sample: SpaceTrackTLE[] = [];
  for (let i = 0; i < 1500; i++) {
    const alt = 200 + ((i * 7) % 450);
    sample.push(mk(`STARLINK-${i}`, alt + 1, alt - 1, [33, 43, 53, 53.2, 70, 97.6, 87.9][i % 7], String(40000 + i), ISS_L1, ISS_L2));
  }
  for (let i = 0; i < 500; i++) sample.push(mk(`OBJ ${i} DEB`, 400 + i, 300 + i, 98));
  const r = S.buildStarlinkReport(sample);
  assert.ok(!JSON.stringify(r).includes("NaN"));
  for (const o of r.objects) {
    assert.ok(Number.isFinite(o.altitudeKm) && Number.isFinite(o.inclinationDeg));
    if (o.phase === "UNASSIGNED") assert.equal(o.shellId, null);
    else assert.notEqual(o.shellId, null);
  }
  for (const s of r.shells) {
    assert.ok(s.meanAltitudeKm === null || Number.isFinite(s.meanAltitudeKm));
    assert.ok(s.altitudeSpreadKm === null || Number.isFinite(s.altitudeSpreadKm));
  }
  assert.equal(r.operational + r.transit + r.deorbiting + r.unassigned, r.starlinkTotal);
});
