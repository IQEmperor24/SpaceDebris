/* lib/maneuver.ts — Avoidance Burn Planner.
   Clohessy-Wiltshire (Hill) linearised relative motion for an in-track
   burn before TCA (impulsive, and finite constant-thrust by superposition),
   VERIFIED against Keplerian two-body truth; the lead x dv trade space with
   the Starlink-style Pc decision rule (STARLINK_PC_MANEUVER_THRESHOLD); time remaining to TCA;
   Tsiolkovsky propellant and burn time; Pc sensitivity / dilution. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EARTH_EQUATORIAL_RADIUS_KM,
  STARLINK_PC_MANEUVER_THRESHOLD,
  circularOrbitState,
  meanMotionRadPerSec,
  ricFrame,
  vAdd,
  vNorm,
  vScale,
  type StateVector,
} from "@/lib/orbital";
import {
  VEHICLE_PRESETS,
  burnDurationSeconds,
  cwDisplacement,
  cwFiniteBurnDisplacement,
  cwVersusTwoBody,
  evaluateBurnTwoBody,
  inTrackDeltaV,
  pcDilution,
  pcSensitivity,
  planAvoidance,
  propellantKg,
  referenceMeanMotionRadPerSec,
  verifyCwAgainstTwoBody,
  type RicDeltaV,
} from "@/lib/maneuver";

const SIGMA: [number, number, number] = [0.3, 1.0, 0.3];
const HBR_M = 20;
function preset(id: string) {
  const v = VEHICLE_PRESETS.find((p) => p.id === id);
  assert.ok(v, `vehicle preset ${id}`);
  return v;
}
const V2MINI = preset("starlink-v2mini");
const HYDRAZINE = preset("generic-hydrazine");

const TARGET = circularOrbitState({ altitudeKm: 550, inclinationDeg: 53, raanDeg: 10, argLatDeg: 70 });
const F = ricFrame(TARGET.position, TARGET.velocity);
/** Head-on secondary 0.3 km above the target at TCA. */
const HEAD_ON: StateVector = { position: vAdd(TARGET.position, vScale(F.radial, 0.3)), velocity: vScale(TARGET.velocity, -1) };
const plan = (secondaryState: StateVector, vehicle = V2MINI) =>
  planAvoidance({ targetState: TARGET, secondaryState, sigmaRicKm: SIGMA, hardBodyRadiusM: HBR_M, vehicle });

test("Tsiolkovsky propellant and burn time", () => {
  assert.ok(Math.abs(propellantKg(0.1, 800, 2500) - 0.0033) < 0.00005, "0.1 m/s on 800 kg at Isp 2500 s ~ 3.3 g");
  assert.ok(Math.abs(burnDurationSeconds(0.1, 800, 0.17) - 470) < 2, "0.1 m/s at 0.17 N ~ 470 s");
  assert.equal(propellantKg(-1, 800, 2500), 0);
  assert.equal(burnDurationSeconds(0.1, 800, 0), Number.POSITIVE_INFINITY);
});

test("CW displacement matches two-body truth to 2 % on every significant component", () => {
  const alt = 550;
  const n = meanMotionRadPerSec(EARTH_EQUATORIAL_RADIUS_KM + alt);
  const burnState = circularOrbitState({ altitudeKm: alt, inclinationDeg: 53, raanDeg: 40, argLatDeg: 25 });
  const axes: Array<[string, RicDeltaV]> = [
    ["in-track", { radialMps: 0, inTrackMps: 0.05, crossTrackMps: 0 }],
    ["radial", { radialMps: 0.05, inTrackMps: 0, crossTrackMps: 0 }],
    ["cross-track", { radialMps: 0, inTrackMps: 0, crossTrackMps: 0.05 }],
  ];
  for (const [axis, dv] of axes) {
    for (const tau of [1800, 3600, 21600, 43200]) {
      const cmp = cwVersusTwoBody(burnState, dv, tau, n);
      assert.ok(cmp, `${axis} tau=${tau}`);
      const truthNorm = Math.hypot(cmp.truth.radialKm, cmp.truth.inTrackKm, cmp.truth.crossTrackKm);
      for (const k of ["radialKm", "inTrackKm", "crossTrackKm"] as const) {
        const t: number = cmp.truth[k];
        const c: number = cmp.cw[k];
        if (Math.abs(t) > 1e-3) {
          assert.equal(Math.sign(c), Math.sign(t), `${axis} tau=${tau} ${k} sign`);
          assert.ok(Math.abs(c - t) / Math.abs(t) < 0.02, `${axis} tau=${tau} ${k}: cw ${c} vs truth ${t}`);
        } else {
          assert.ok(Math.abs(c - t) < 0.02 * truthNorm, `${axis} tau=${tau} ${k}: negligible component`);
        }
      }
    }
  }
  const tcaState = circularOrbitState({ altitudeKm: alt, inclinationDeg: 53, raanDeg: 40, argLatDeg: 200 });
  const maxErr = verifyCwAgainstTwoBody(tcaState);
  assert.ok(maxErr !== null && maxErr < 0.02, `live linearisation check ${maxErr}`);
});

test("CW physics: a prograde burn is ABOVE and BEHIND half an orbit later, x = 4 dv / n", () => {
  const n = meanMotionRadPerSec(EARTH_EQUATORIAL_RADIUS_KM + 550);
  const d = cwDisplacement({ radialMps: 0, inTrackMps: 0.1, crossTrackMps: 0 }, Math.PI / n, n);
  assert.ok(d.radialKm > 0);
  assert.ok(d.inTrackKm < 0);
  assert.ok(Math.abs(d.radialKm - (4 * 0.0001) / n) < 1e-9);
});

test("head-on: the trade space is complete and the minimum-dv burn clears the Starlink trigger", () => {
  const ts = plan(HEAD_ON);
  assert.ok(Math.abs(ts.baseline.missKm - 0.3) < 1e-6);
  assert.ok(ts.baseline.pc >= 1e-4, `baseline Pc ${ts.baseline.pc}`);
  assert.equal(ts.thresholdPc, STARLINK_PC_MANEUVER_THRESHOLD);
  assert.equal(ts.maneuverRequired, true);
  assert.deepEqual(ts.leads, [43200, 28800, 21600, 14400, 10800, 7200, 3600, 1800]);
  assert.deepEqual(ts.dvs, [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0]);
  assert.equal(ts.cells.length, 8 * 7 * 2, "leads x dvs x {prograde, retrograde}");
  for (const c of ts.cells) {
    assert.ok(Number.isFinite(c.missKm) && c.pc >= 0 && c.pc <= 1);
    assert.ok(Number.isFinite(c.propellantKg) && Number.isFinite(c.burnSeconds));
  }
  const rec = ts.recommended;
  assert.ok(rec && rec.feasible && rec.pc < STARLINK_PC_MANEUVER_THRESHOLD && rec.missKm > ts.baseline.missKm);
  // Head-on, only RADIAL displacement moves the encounter-plane miss, and an
  // in-track burn's radial lever is at most 4 dv / n: even clearing 1e-5 under
  // sigma_R = 0.3 km needs ~0.27 m/s at the best phase (3e-7 needs more).
  const best = ts.cells.filter((c) => c.dvMps <= 0.2).reduce((m, c) => (c.pc < m.pc ? c : m));
  assert.ok(best.pc > 1e-5, "<= 0.2 m/s cannot clear a head-on 0.3 km radial miss");
  assert.equal(rec.dvMps, 0.5);
  for (const c of ts.cells) {
    if (!c.meetsThreshold) continue;
    assert.ok(c.dvMps >= rec.dvMps, "minimum dv first");
    if (c.dvMps === rec.dvMps) assert.ok(c.leadSeconds <= rec.leadSeconds, "then the longest lead");
  }
});

test("head-on: the recommended burn (finite, centred on its lead) is confirmed by two-body truth", () => {
  const rec = plan(HEAD_ON).recommended;
  assert.ok(rec);
  const truth = evaluateBurnTwoBody({ targetState: TARGET, secondaryState: HEAD_ON, sigmaRicKm: SIGMA, hardBodyRadiusM: HBR_M }, rec.leadSeconds, rec.dvMps, rec.direction, rec.burnSeconds);
  assert.ok(truth);
  assert.ok(Math.abs(truth.missKm - rec.missKm) / rec.missKm < 0.02, "CW miss within 2 % of two-body");
  assert.ok(truth.pc < STARLINK_PC_MANEUVER_THRESHOLD);
  const err = verifyCwAgainstTwoBody(TARGET, undefined, rec.dvMps);
  assert.ok(err !== null && err < 0.02);
});

test("feasibility: a low-thrust vehicle cannot fit a 1 m/s burn in a 30 min lead", () => {
  const slow = plan(HEAD_ON).cells.find((c) => c.dvMps === 1.0 && c.leadSeconds === 1800);
  assert.ok(slow);
  assert.equal(slow.feasible, false);
  assert.equal(slow.meetsThreshold, false, "an infeasible burn never counts as clearing");
  assert.ok(plan(HEAD_ON, HYDRAZINE).cells.every((c) => c.feasible), "22 N hydrazine: every cell feasible");
});

test("crossing geometry: long-lead in-track drift clears with <= 0.2 m/s", () => {
  const crossing: StateVector = { position: vAdd(TARGET.position, vScale(F.radial, 0.3)), velocity: vScale(F.crossTrack, vNorm(TARGET.velocity)) };
  const ts = plan(crossing);
  assert.ok(ts.baseline.pc > 1e-5);
  const rec = ts.recommended;
  assert.ok(rec && rec.dvMps <= 0.2 && rec.pc < STARLINK_PC_MANEUVER_THRESHOLD);
  const truth = evaluateBurnTwoBody({ targetState: TARGET, secondaryState: crossing, sigmaRicKm: SIGMA, hardBodyRadiusM: HBR_M }, rec.leadSeconds, rec.dvMps, rec.direction, rec.burnSeconds);
  assert.ok(truth && Math.abs(truth.missKm - rec.missKm) / rec.missKm < 0.02 && truth.pc < STARLINK_PC_MANEUVER_THRESHOLD);
});

test("finite burn: CW superposition matches two-body sub-impulses; a negligible burn is impulsive", () => {
  const n = referenceMeanMotionRadPerSec(TARGET);
  const dv = inTrackDeltaV(0.5, "PROGRADE");
  const impulsive = cwDisplacement(dv, 6 * 3600, n);
  assert.ok(Math.abs(cwFiniteBurnDisplacement(dv, 6 * 3600, 0.5, n).radialKm - impulsive.radialKm) < 1e-9);
  const burnS = burnDurationSeconds(0.5, 800, 0.17); // ~39 min on a 0.17 N thruster
  for (const lead of [3600, 6 * 3600, 12 * 3600]) {
    const fin = cwFiniteBurnDisplacement(dv, lead, burnS, n);
    const tb = evaluateBurnTwoBody({ targetState: TARGET, secondaryState: HEAD_ON, sigmaRicKm: SIGMA, hardBodyRadiusM: HBR_M }, lead, 0.5, "PROGRADE", burnS);
    assert.ok(tb, `lead ${lead}`);
    assert.ok(Math.abs(fin.inTrackKm - tb.ricKm.inTrackKm) / Math.abs(tb.ricKm.inTrackKm) < 0.02, `lead ${lead}: in-track within 2 %`);
    // Radial residual is the known curvature term y^2 / 2r (<= 2 % of |d|).
    const d = Math.hypot(tb.ricKm.radialKm, tb.ricKm.inTrackKm);
    assert.ok(Math.abs(fin.radialKm - tb.ricKm.radialKm) < 0.02 * d + 1e-3, `lead ${lead}: radial`);
  }
});

test("time remaining to TCA: leads that are already past are flagged too late", () => {
  const withTime = (availableSeconds: number) =>
    planAvoidance({ targetState: TARGET, secondaryState: HEAD_ON, sigmaRicKm: SIGMA, hardBodyRadiusM: HBR_M, vehicle: HYDRAZINE, availableSeconds });
  const in3h = withTime(3 * 3600);
  assert.equal(in3h.availableSeconds, 3 * 3600);
  for (const c of in3h.cells) {
    if (c.leadSeconds > 3 * 3600) assert.ok(c.tooLate && !c.feasible && !c.meetsThreshold, `lead ${c.leadSeconds}`);
  }
  assert.ok(in3h.recommended === null || in3h.recommended.leadSeconds <= 3 * 3600);
  assert.equal(withTime(-50).availableSeconds, null, "non-positive time remaining -> unconstrained");
  const in20m = withTime(20 * 60);
  assert.equal(in20m.recommended, null, "no lead fits inside 20 minutes");
  assert.ok(in20m.cells.every((c) => c.tooLate));
});

test("an already-safe conjunction needs no maneuver", () => {
  const far: StateVector = { position: vAdd(TARGET.position, vScale(F.radial, 5)), velocity: vScale(TARGET.velocity, -1) };
  assert.equal(plan(far).maneuverRequired, false);
});

test("Pc sensitivity: dilution region flagged for a sub-sigma miss, not for a 5 km miss", () => {
  const curve = pcSensitivity(TARGET, HEAD_ON, SIGMA, HBR_M);
  assert.deepEqual(curve.map((c) => c.scale), [0.25, 0.5, 1, 2, 4, 8]);
  for (const c of curve) assert.ok(Number.isFinite(c.pc) && c.pc >= 0 && c.pc <= 1);
  for (let i = 3; i < curve.length; i++) assert.ok(curve[i].pc < curve[i - 1].pc, "monotone above the peak");
  const dil = pcDilution(TARGET, HEAD_ON, SIGMA, HBR_M);
  // Isotropic encounter plane (sigma_R = sigma_C = 0.3 km per object): peak at miss / (sqrt 2 sigma_combined) ~ 0.5x.
  assert.ok(Math.abs(dil.peakScale - 0.5) < 0.08, `peak scale ${dil.peakScale}`);
  assert.equal(dil.diluted, true);
  const far: StateVector = { position: vAdd(TARGET.position, vScale(F.radial, 5)), velocity: vScale(TARGET.velocity, -1) };
  const farCurve = pcSensitivity(TARGET, far, SIGMA, HBR_M);
  assert.equal(pcDilution(TARGET, far, SIGMA, HBR_M).diluted, false);
  assert.ok(farCurve[3].pc > farCurve[2].pc, "a 5 km miss: Pc rises with sigma at nominal");
});

test("invalid states are rejected, never propagated into NaN", () => {
  assert.throws(() => plan({ position: [Number.NaN, 0, 0], velocity: [0, 7, 0] }));
  assert.throws(() => planAvoidance({ targetState: { position: [Number.NaN, 0, 0], velocity: [0, 7, 0] }, secondaryState: HEAD_ON, sigmaRicKm: SIGMA, hardBodyRadiusM: HBR_M, vehicle: V2MINI }));
  assert.deepEqual(pcSensitivity({ position: [0, 0, 0], velocity: [0, 0, 0] }, HEAD_ON, SIGMA, HBR_M), []);
  assert.equal(verifyCwAgainstTwoBody({ position: [1, 2, 3], velocity: [0, 0, 0] }), null);
});

test("performance: the full 112-cell trade space plans interactively", () => {
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) plan(HEAD_ON);
  const ms = (performance.now() - t0) / 10;
  // ~40 ms per plan on a laptop; the bound is generous so shared CI runners never flake.
  assert.ok(ms < 1000, `planAvoidance ${ms.toFixed(1)} ms`);
});
