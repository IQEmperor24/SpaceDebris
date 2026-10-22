/* lib/screening.ts — the SGP4 all-on-one conjunction screen.
   Synthetic catalogs built from the ISS TLE: a co-orbital "shadow" object
   4-6 km ahead, altitude-band decoys, a 2,000-object performance sample,
   and an independent dense brute-force cross-check of the sieve. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCREENING_OPTIONS, gradeSeverity, screenTarget } from "@/lib/screening";
import { minutesSinceEpoch, parseTle, propagateMinutes, vNorm, vSub } from "@/lib/orbital";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { ISS_EPOCH as START, ISS_L1, ISS_L2, angleField, setCols, setNorad, tleRow } from "./fixtures";

const DAY_MS = 24 * 3600e3;
const ISS = tleRow("ISS (ZARYA)", "25544", ISS_L1, ISS_L2);
// Same orbit, mean anomaly +0.04 deg -> roughly 4.7 km ahead in-track.
const [SEC_L1, SEC_L2] = setNorad(ISS_L1, setCols(ISS_L2, 44, 51, "325.0688"), "99901");
const SHADOW = tleRow("ISS SHADOW TEST", "99901", SEC_L1, SEC_L2);
const GEO = tleRow(
  "GOES 13",
  "29155",
  "1 29155U 06018A   24001.50000000  .00000100  00000-0  00000+0 0  9990",
  "2 29155   0.0200  90.0000 0002000 100.0000 200.0000  1.00270000 50000"
);
const DEB860 = tleRow(
  "SL-16 DEB",
  "22830",
  "1 22830U 93061Z   24001.50000000  .00000500  00000-0  20000-3 0  9991",
  "2 22830  98.7000 100.0000 0010000  50.0000 310.0000 14.10000000 12345"
);

test("co-orbital shadow: one approach, in-track dominant, RIC consistent, graded by the rule", () => {
  const r = screenTarget(ISS, [SHADOW, GEO, DEB860], START);
  assert.equal(r.target.noradId, "25544");
  assert.ok(r.target.meanAltitudeKm > 400 && r.target.meanAltitudeKm < 440);
  assert.ok(Math.abs(r.target.inclinationDeg - 51.64) < 0.01);
  assert.equal(r.windowStart, START.toISOString());
  assert.equal(r.windowEnd, new Date(START.getTime() + DAY_MS).toISOString());
  assert.equal(r.sampleSize, 3);
  assert.equal(r.candidatesScreened, 1, "GEO and 860 km decoys are removed by the altitude prefilter");
  assert.equal(r.truncated, false);
  assert.deepEqual(r.assumptions.sigmaRicKm, [0.3, 1.0, 0.3]);
  assert.equal(r.assumptions.hardBodyRadiusM, 20);
  assert.deepEqual(r.assumptions.keepOutBoxKm, { radial: 2, inTrack: 25, crossTrack: 25 });
  assert.equal(r.assumptions.coarseStepSeconds, 60);

  assert.equal(r.closeApproaches.length, 1, "one row per secondary, not one per revolution");
  const ca = r.closeApproaches[0];
  assert.equal(ca.noradId, "99901");
  assert.equal(ca.objectClass, "PAYLOAD");
  assert.ok(ca.missDistanceKm >= 4 && ca.missDistanceKm <= 6, `miss ${ca.missDistanceKm}`);
  assert.ok(ca.inTrackKm > 0, "secondary is AHEAD in-track");
  assert.ok(Math.abs(ca.inTrackKm) > Math.abs(ca.radialKm) && Math.abs(ca.inTrackKm) > Math.abs(ca.crossTrackKm));
  assert.ok(ca.relativeVelocityKmS < 0.05, `co-orbital relative velocity ${ca.relativeVelocityKmS}`);
  assert.ok(Math.abs(Math.hypot(ca.radialKm, ca.inTrackKm, ca.crossTrackKm) - ca.missDistanceKm) < 1e-6);
  const tca = Date.parse(ca.tca);
  assert.ok(tca >= START.getTime() && tca <= START.getTime() + DAY_MS, "TCA inside the window");
  assert.ok(ca.probabilityOfCollision >= 0 && ca.probabilityOfCollision < 1e-4);
  assert.equal(ca.insideKeepOutBox, true, "4.7 km in-track sits inside the +-2 x 25 x 25 km box");
  assert.equal(ca.severity, gradeSeverity(ca.probabilityOfCollision, ca.missDistanceKm, ca.insideKeepOutBox));
  assert.equal(ca.severity, "HIGH");

  // Session 6: TCA state vectors are attached for the avoidance planner.
  assert.ok(ca.targetStateEci && ca.secondaryStateEci);
  const sep = vNorm(vSub(ca.secondaryStateEci.position, ca.targetStateEci.position));
  assert.ok(Math.abs(sep - ca.missDistanceKm) < 1e-6, "attached states reproduce the miss distance");
  const vrel = vNorm(vSub(ca.secondaryStateEci.velocity, ca.targetStateEci.velocity));
  assert.ok(Math.abs(vrel - ca.relativeVelocityKmS) < 1e-9);
});

test("decoys: nothing reported, even when forced through the prefilter", () => {
  const none = screenTarget(ISS, [GEO, DEB860], START);
  assert.equal(none.candidatesScreened, 0);
  assert.equal(none.closeApproaches.length, 0);
  const forced = screenTarget(ISS, [GEO, DEB860], START, { altitudeBandKm: 1e6, windowHours: 6 });
  assert.equal(forced.candidatesScreened, 2);
  assert.equal(forced.closeApproaches.length, 0);
});

test("severity rule: CRITICAL Pc>=1e-4 or <1 km; HIGH Pc>=1e-5 or box; MEDIUM <10 km; else LOW", () => {
  assert.equal(gradeSeverity(2e-4, 20, false), "CRITICAL");
  assert.equal(gradeSeverity(0, 0.5, false), "CRITICAL");
  assert.equal(gradeSeverity(2e-5, 20, false), "HIGH");
  assert.equal(gradeSeverity(0, 20, true), "HIGH");
  assert.equal(gradeSeverity(0, 9.9, false), "MEDIUM");
  assert.equal(gradeSeverity(0, 10, false), "LOW");
});

test("an unparseable target is rejected with a clear error", () => {
  assert.throws(() => screenTarget(tleRow("BAD", "1", "garbage", "garbage"), [SHADOW], START), /Target TLE could not be parsed/);
});

/** 2,000 ISS clones spread in RAAN, plus the ISS itself (must be skipped). */
function raanClones(): SpaceTrackTLE[] {
  const rows: SpaceTrackTLE[] = [];
  for (let i = 0; i < 2000; i++) {
    const l2 = setCols(ISS_L2, 18, 25, angleField(((i * 360) / 2000) % 360));
    const [l1id, l2id] = setNorad(ISS_L1, l2, String(50000 + i));
    rows.push(tleRow(`CLONE ${i}`, String(50000 + i), l1id, l2id));
  }
  rows.push(ISS);
  return rows;
}

test("performance: a 24 h screen of a 2,000-object sample finishes well inside the budget", () => {
  const sample = raanClones();
  const t0 = performance.now();
  const r = screenTarget(ISS, sample, START);
  const elapsed = performance.now() - t0;
  assert.equal(r.sampleSize, 2001);
  assert.equal(r.candidatesScreened, DEFAULT_SCREENING_OPTIONS.maxCandidates, "capped at maxCandidates");
  assert.equal(r.truncated, false);
  assert.ok(r.closeApproaches.length <= DEFAULT_SCREENING_OPTIONS.maxResults);
  for (const e of r.closeApproaches) {
    assert.notEqual(e.noradId, "25544", "the target never screens against itself");
    assert.ok(e.missDistanceKm <= DEFAULT_SCREENING_OPTIONS.reportThresholdKm);
    assert.ok(Number.isFinite(e.probabilityOfCollision) && e.probabilityOfCollision >= 0 && e.probabilityOfCollision <= 1);
  }
  for (let i = 1; i < r.closeApproaches.length; i++) {
    assert.ok(r.closeApproaches[i - 1].missDistanceKm <= r.closeApproaches[i].missDistanceKm, "sorted by miss");
  }
  // ~1 s on a laptop; 10 s keeps shared CI runners from flaking while still
  // catching an accidental O(n^2) or a lost prefilter.
  assert.ok(elapsed < 10_000, `screen took ${elapsed.toFixed(0)} ms`);
});

test("time budget: a 1 ms budget sets the truncated flag", () => {
  const r = screenTarget(ISS, raanClones(), START, { timeBudgetMs: 1 });
  assert.equal(r.truncated, true);
  assert.ok(r.candidatesScreened < DEFAULT_SCREENING_OPTIONS.maxCandidates);
});

test("cross-check: dense 20 s brute force never finds an approach the sieve dropped", () => {
  const HOURS = 6;
  const THRESH = 50;
  const STEP = 20;
  const sample: SpaceTrackTLE[] = [];
  for (let i = 0; i < 600; i++) {
    let l2 = setCols(ISS_L2, 18, 25, angleField(((i * 360) / 600) % 360));
    l2 = setCols(l2, 44, 51, angleField((325.0288 + (i % 17) * 0.37) % 360));
    l2 = setCols(l2, 9, 16, angleField(51.64 + ((i % 5) - 2) * 0.05));
    const id = String(60000 + i);
    sample.push(tleRow(`CLONE ${i}`, id, setCols(ISS_L1, 3, 7, id), setCols(l2, 3, 7, id)));
  }
  const result = screenTarget(ISS, sample, START, { windowHours: HOURS, maxResults: 1000, reportThresholdKm: THRESH });
  assert.equal(result.truncated, false);
  assert.equal(result.candidatesScreened, 600);
  assert.ok(result.closeApproaches.length > 0, "the jittered clone field produces approaches");
  const reported = new Map(result.closeApproaches.map((e) => [e.noradId, e]));

  const target = parseTle(ISS_L1, ISS_L2);
  assert.ok(target);
  const t0 = minutesSinceEpoch(target, START);
  const steps = (HOURS * 3600) / STEP;
  const targetPos = Array.from({ length: steps + 1 }, (_, k) => propagateMinutes(target, t0 + (k * STEP) / 60)?.position ?? null);

  let missing = 0;
  for (const c of sample) {
    const sat = parseTle(c.TLE_LINE1, c.TLE_LINE2);
    assert.ok(sat);
    const c0 = minutesSinceEpoch(sat, START);
    let dmin = Infinity;
    for (let k = 0; k <= steps; k++) {
      const tp = targetPos[k];
      const sv = propagateMinutes(sat, c0 + (k * STEP) / 60);
      if (!tp || !sv) continue;
      dmin = Math.min(dmin, Math.hypot(sv.position[0] - tp[0], sv.position[1] - tp[1], sv.position[2] - tp[2]));
    }
    const rep = reported.get(c.NORAD_CAT_ID);
    if (rep) assert.ok(rep.missDistanceKm <= dmin + 1e-6, `${c.OBJECT_NAME}: refined miss exceeds the grid minimum`);
    else if (dmin <= THRESH) missing++;
  }
  assert.equal(missing, 0, "the sieve must never drop a <= 50 km approach");

  // Every reported TCA is a genuine local minimum: +-60 s at 1 s spacing never beats it.
  for (const e of result.closeApproaches) {
    const c = sample.find((s) => s.NORAD_CAT_ID === e.noradId);
    assert.ok(c);
    const sat = parseTle(c.TLE_LINE1, c.TLE_LINE2);
    assert.ok(sat);
    const tcaSec = (Date.parse(e.tca) - START.getTime()) / 1000;
    for (let dt = -60; dt <= 60; dt++) {
      const tp = propagateMinutes(target, t0 + (tcaSec + dt) / 60);
      const cp = propagateMinutes(sat, minutesSinceEpoch(sat, START) + (tcaSec + dt) / 60);
      assert.ok(tp && cp);
      assert.ok(vNorm(vSub(cp.position, tp.position)) >= e.missDistanceKm - 1e-3, `${e.name} beaten at TCA${dt}s`);
    }
  }
});
