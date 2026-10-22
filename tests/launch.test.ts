/* lib/launch.ts — simplified launch collision avoidance (COLA) screen.
   Insertion at T+9 min, 20 deg downrange in the plane through the site,
   20 min two-body coast screened every 30 s (with refinement) against the
   catalog sample. NO-GO < 5 km, CAUTION < 25 km, else GO. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as O from "@/lib/orbital";
import * as L from "@/lib/launch";
import { ISS_L1, ISS_L2, gpRow, synthCatalog, synthLines } from "./fixtures";

const T0 = new Date("2026-10-21T14:00:00Z");
const CAT_EPOCH = new Date("2026-10-21T12:00:00Z");
const approx = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const angleDeg = (a: O.Vec3, b: O.Vec3): number => (Math.acos(Math.max(-1, Math.min(1, O.vDot(O.vUnit(a), O.vUnit(b))))) * 180) / Math.PI;
function site(id: string): L.LaunchSite {
  const s = L.findLaunchSite(id);
  assert.ok(s, id);
  return s;
}
function orbit(id: string): L.TargetOrbit {
  const o = L.findTargetOrbit(id);
  assert.ok(o, id);
  return o;
}

test("catalogs: 4 sites, 4 target orbits, prototype-safe lookups", () => {
  assert.equal(L.LAUNCH_SITES.length, 4);
  assert.equal(L.TARGET_ORBITS.length, 4);
  assert.equal(new Set(L.LAUNCH_SITES.map((s) => s.id)).size, 4);
  assert.equal(new Set(L.TARGET_ORBITS.map((o) => o.id)).size, 4);
  assert.equal(site("slc-4e").latitudeDeg, 34.632);
  assert.equal(orbit("iss").inclinationDeg, 51.64);
  assert.equal(L.findLaunchSite("__proto__"), null);
  assert.equal(L.findTargetOrbit("constructor"), null);
  assert.deepEqual([...L.COLA_WINDOW_OPTIONS], [60, 120, 240]);
});

test("insertion geometry for every site x orbit: altitude, inclination, plane through the site, 20 deg downrange", () => {
  for (const s of L.LAUNCH_SITES) {
    for (const o of L.TARGET_ORBITS) {
      const tag = `${s.id} -> ${o.id}`;
      assert.ok(L.orbitReachable(s, o), tag);
      const g = L.insertionGeometry(s, o, T0);
      assert.ok(g, tag);
      assert.equal(L.insertionState(s, o, T0)?.position[0], g.state.position[0]);
      const r = O.vNorm(g.state.position);
      const h = O.vCross(g.state.position, g.state.velocity);
      const siteR = O.siteEci(s, T0);
      assert.ok(approx(r, O.EARTH_EQUATORIAL_RADIUS_KM + o.altitudeKm, 1e-6), `${tag} radius`);
      assert.ok(approx(O.vNorm(g.state.velocity), Math.sqrt(O.MU_EARTH_KM3_S2 / r), 1e-9), `${tag} circular speed`);
      assert.ok(approx((Math.acos(h[2] / O.vNorm(h)) * 180) / Math.PI, o.inclinationDeg, 1e-6), `${tag} inclination`);
      assert.ok(Math.abs(O.vDot(O.vUnit(h), siteR)) < 1e-6 * O.vNorm(siteR), `${tag} plane contains the site`);
      assert.ok(approx(angleDeg(siteR, g.state.position), L.DOWNRANGE_DEG, 1e-6), `${tag} downrange`);
      assert.ok(O.vDot(O.vCross(siteR, g.state.position), h) > 0, `${tag} insertion is AHEAD of the site`);
      assert.equal(g.insertionEpoch.getTime(), T0.getTime() + L.INSERTION_DELAY_S * 1000);
      const expectSouth = s.id === "slc-4e" || o.inclinationDeg > 90;
      assert.equal(g.direction, expectSouth ? "SOUTHBOUND" : "NORTHBOUND", tag);
      assert.equal(Math.cos((g.siteArgLatDeg * Math.PI) / 180) < 0, expectSouth, `${tag} pass direction at the site`);
      if (!expectSouth) assert.ok(approx(g.raanDeg, O.raanThroughPosition(siteR, o.inclinationDeg) ?? Number.NaN, 1e-9));
    }
  }
  const south = L.insertionGeometry(site("slc-4e"), orbit("starlink-550"), T0);
  assert.ok(south);
  const atSite = O.circularOrbitState({ altitudeKm: 0, inclinationDeg: 53, raanDeg: south.raanDeg, argLatDeg: south.siteArgLatDeg });
  assert.ok(atSite.velocity[2] < 0, "SLC-4E flies south");
  assert.ok(O.vDot(O.vUnit(atSite.position), O.vUnit(O.siteEci(site("slc-4e"), T0))) > 0.999999);
});

test("unreachable inclinations and invalid arguments are rejected", () => {
  const cape = site("slc-40");
  const low: L.TargetOrbit = { id: "x", label: "LOW 400 km / 20°", altitudeKm: 400, inclinationDeg: 20 };
  const retro: L.TargetOrbit = { id: "y", label: "RETRO 400 km / 170°", altitudeKm: 400, inclinationDeg: 170 };
  assert.equal(L.insertionState(cape, low, T0), null, "i = 20 deg < latitude 28.6 deg");
  assert.equal(L.orbitReachable(cape, low), false);
  assert.equal(L.insertionState(cape, retro, T0), null, "180 - i < latitude");
  assert.throws(() => L.screenLaunchWindow(cape, low, [], T0, 60), (e: unknown) => e instanceof RangeError && /cannot be reached/.test(e.message));
  assert.equal(L.insertionState(cape, L.TARGET_ORBITS[0], new Date(Number.NaN)), null);
  const o = L.TARGET_ORBITS[0];
  for (const bad of [
    () => L.screenLaunchWindow(cape, o, [], new Date(Number.NaN), 60),
    () => L.screenLaunchWindow(cape, o, [], T0, 0),
    () => L.screenLaunchWindow(cape, o, [], T0, 99999),
    () => L.screenLaunchWindow(cape, o, [], T0, 60, { stepMinutes: 1.5 }),
    () => L.screenLaunchWindow(cape, o, [], T0, 60, { timeBudgetMs: -1 }),
  ]) {
    assert.throws(bad, RangeError);
  }
});

test("grading thresholds and the next-clear-window summary", () => {
  assert.equal(L.colaStatus(4.999), "NO-GO");
  assert.equal(L.colaStatus(5), "CAUTION");
  assert.equal(L.colaStatus(24.99), "CAUTION");
  assert.equal(L.colaStatus(25), "GO");
  assert.equal(L.colaStatus(null), "GO");
  assert.equal(L.colaStatus(Number.NaN), "GO");
  const mk = (status: L.ColaStatus, i: number): L.ColaMinute => ({
    launchTime: new Date(T0.getTime() + i * 60000).toISOString(), status, minMissKm: 1, objectName: "X", noradId: "1", tca: null,
  });
  const seq = (["NO-GO", "CAUTION", "GO", "GO", "NO-GO", "GO"] as L.ColaStatus[]).map(mk);
  const s1 = L.summarizeColaMinutes(seq, 1);
  assert.deepEqual([s1.go, s1.caution, s1.noGo], [3, 1, 2]);
  assert.deepEqual(s1.nextClearWindow, { start: seq[2].launchTime, minutes: 2 });
  assert.equal(L.summarizeColaMinutes(seq, 2).nextClearWindow?.minutes, 4);
  assert.equal(L.summarizeColaMinutes([mk("NO-GO", 0), mk("CAUTION", 1)], 1).nextClearWindow, null);
  assert.deepEqual(L.summarizeColaMinutes([], 1), { go: 0, caution: 0, noGo: 0, nextClearWindow: null });
});

test("constructed encounter: refinement finds a 3 km miss that the raw 30 s samples skip", () => {
  const iss = O.parseTle(ISS_L1, ISS_L2);
  assert.ok(iss);
  const E = new Date("2024-01-01T13:00:00Z");
  const tcaS = 615; // between the 600 s and 630 s samples
  const S = O.propagateAt(iss, new Date(E.getTime() + tcaS * 1000));
  assert.ok(S);
  // Rotate the ISS velocity 60 deg about the radial axis: a crossing orbit, same speed (Rodrigues).
  const k = O.vUnit(S.position);
  const c = Math.cos(Math.PI / 3);
  const s = Math.sin(Math.PI / 3);
  const kxv = O.vCross(k, S.velocity);
  const kdv = O.vDot(k, S.velocity);
  const vRot: O.Vec3 = [0, 1, 2].map((i) => S.velocity[i] * c + kxv[i] * s + k[i] * kdv * (1 - c)) as O.Vec3;
  const insertion = O.twoBodyPropagate({ position: O.vAdd(S.position, O.vScale(k, 3)), velocity: vRot }, -tcaS);
  assert.ok(insertion);
  const res = L.screenOneLaunch(insertion, E, [{ satrec: iss, name: "ISS (ZARYA)", noradId: "25544" }]);

  let dense = Infinity;
  let sampled = Infinity;
  for (let t = 0; t <= 1200; t++) {
    const veh = O.twoBodyPropagate(insertion, t);
    const sv = O.propagateAt(iss, new Date(E.getTime() + t * 1000));
    assert.ok(veh && sv);
    const d = O.vNorm(O.vSub(sv.position, veh.position));
    dense = Math.min(dense, d);
    if (t % 30 === 0) sampled = Math.min(sampled, d);
  }
  assert.ok(res.minMissKm !== null && res.minMissKm > 2.5 && res.minMissKm < 3.05, `refined ${res.minMissKm}`);
  assert.ok(Math.abs(res.minMissKm - dense) < 0.1, "within 0.1 km of a dense 1 s brute force");
  assert.ok(res.tcaOffsetS !== null && Math.abs(res.tcaOffsetS - tcaS) < 3);
  assert.ok(sampled > 50, `30 s samples alone see ${sampled.toFixed(1)} km`);
  assert.equal(L.colaStatus(res.minMissKm), "NO-GO");
  assert.equal(res.candidateIndex, 0);
  assert.equal(res.propagations, 81, "41 SGP4 + 40 two-body");
  assert.ok(res.tca !== null && Math.abs(res.tca.getTime() - (E.getTime() + res.tcaOffsetS * 1000)) < 1);
  const none = L.screenOneLaunch(insertion, E, []);
  assert.deepEqual([none.minMissKm, none.candidateIndex, none.tca], [null, -1, null]);
});

test("prefilter: altitude band from gp strings, TLE fallback, junk rows dropped", () => {
  const lines = (norad: number, altKm: number) => synthLines({ norad, epoch: CAT_EPOCH, altKm, incDeg: 53, raanDeg: 10, maDeg: 0 });
  const [a1, a2] = lines(80001, 550);
  const [b1, b2] = lines(80002, 800);
  const [c1, c2] = lines(80003, 560);
  const row = (name: string, norad: string, l1: string, l2: string, peri: string, apo: string) =>
    gpRow({ OBJECT_NAME: name, NORAD_CAT_ID: norad, TLE_LINE1: l1, TLE_LINE2: l2, PERIAPSIS: peri, APOAPSIS: apo });
  const rows: unknown[] = [
    row("IN-BAND", "80001", a1, a2, "549.5", "550.5"),
    row("TOO-HIGH", "80002", b1, b2, "799.5", "800.5"),
    row("NO-STRINGS", "80003", c1, c2, "", "abc"),
    row("BAD-TLE", "80004", "garbage", "garbage", "550", "550"),
    row("", "", a1, a2, "550", "550"),
    null,
    { nope: 1 },
  ];
  const cands = L.selectColaCandidates(orbit("starlink-550"), rows);
  assert.deepEqual(cands.map((c) => c.name), ["IN-BAND", "NO-STRINGS", "NORAD 80001"]);
  assert.equal(cands[2].noradId, "80001", "NORAD id recovered from the satrec");
  assert.deepEqual(L.selectColaCandidates(L.TARGET_ORBITS[0], null as unknown as unknown[]), []);
});

test("the shared-grid fast path equals the per-launch reference, minute by minute", () => {
  const sample = synthCatalog(300, CAT_EPOCH, 500, 600, 7);
  const s = site("slc-40");
  const o = orbit("starlink-550");
  const cands = L.selectColaCandidates(o, sample);
  for (const stepMinutes of [1, 3, 30]) {
    const windowMin = stepMinutes === 30 ? 120 : 30;
    const res = L.screenLaunchWindow(s, o, sample, T0, windowMin, { stepMinutes });
    assert.equal(res.minutes.length, windowMin / stepMinutes);
    res.minutes.forEach((m, i) => {
      const lt = new Date(T0.getTime() + i * stepMinutes * 60000);
      const g = L.insertionGeometry(s, o, lt);
      assert.ok(g);
      const ref = L.screenOneLaunch(g.state, g.insertionEpoch, cands);
      assert.ok(ref.minMissKm !== null && ref.tca !== null && m.minMissKm !== null && m.tca !== null);
      assert.ok(Math.abs(Math.round(ref.minMissKm * 1000) / 1000 - m.minMissKm) <= 0.0011, `step ${stepMinutes} minute ${i}`);
      assert.equal(m.noradId, cands[ref.candidateIndex].noradId);
      assert.equal(m.launchTime, lt.toISOString());
      assert.ok(Math.abs(Date.parse(m.tca) - Math.round(ref.tca.getTime())) <= 1);
    });
  }
});

test("a 120-minute window: consistent, deterministic, NaN-free", () => {
  const sample = synthCatalog(600, CAT_EPOCH, 450, 650, 11);
  const s = site("lc-39a");
  const o = orbit("starlink-550");
  const res = L.screenLaunchWindow(s, o, sample, T0, 120);
  const C = res.candidatesScreened;
  assert.equal(res.minutes.length, 120);
  assert.ok(C > 0 && C < 600 && res.sampleSize === 600);
  for (const m of res.minutes) {
    assert.ok(typeof m.minMissKm === "number" && Number.isFinite(m.minMissKm));
    assert.equal(m.status, L.colaStatus(m.minMissKm));
    const tca = Date.parse(m.tca ?? "");
    const lt = Date.parse(m.launchTime);
    assert.ok(m.objectName && m.noradId && tca >= lt + 540_000 && tca <= lt + 540_000 + 1_200_000, "TCA inside the coast");
  }
  assert.equal(res.propagations, C * (2 * (120 - 1) + 41) + 120 * 40, "shared SGP4 grid + per-launch two-body");
  assert.equal(res.truncated, false);
  assert.equal(res.summary.go + res.summary.caution + res.summary.noGo, 120);
  assert.equal(res.windowStart, T0.toISOString());
  assert.equal(Date.parse(res.windowEnd) - Date.parse(res.windowStart), 120 * 60000);
  assert.deepEqual(res.assumptions, { insertionDelayS: 540, downrangeDeg: 20, screenAfterInsertionS: 1200, screenStepS: 30, altBandKm: 50, redKm: 5, yellowKm: 25 });
  assert.ok(!/NaN|undefined/.test(JSON.stringify(res)));
  const firstGo = res.minutes.findIndex((m) => m.status === "GO");
  assert.equal(res.summary.nextClearWindow?.start ?? null, firstGo < 0 ? null : res.minutes[firstGo].launchTime);
  const again = L.screenLaunchWindow(s, o, sample, T0, 120);
  assert.deepEqual({ ...again, computeMs: 0 }, { ...res, computeMs: 0 }, "same inputs, same output");
  const empty = L.screenLaunchWindow(s, o, [], T0, 60);
  assert.ok(empty.minutes.every((m) => m.status === "GO" && m.minMissKm === null && m.tca === null));
  assert.equal(empty.propagations, 0);
  assert.equal(empty.summary.nextClearWindow?.minutes, 60);
});

test("a catalog object sitting on the minute-0 insertion point blocks minute 0 only", () => {
  const s = site("slc-40");
  const o = orbit("starlink-550");
  const g = L.insertionGeometry(s, o, T0);
  assert.ok(g);
  const [l1, l2] = synthLines({ norad: 99999, epoch: g.insertionEpoch, altKm: o.altitudeKm, incDeg: o.inclinationDeg, raanDeg: g.raanDeg, maDeg: g.insertionArgLatDeg, ecc: 0.0001, argpDeg: 0 });
  const twin = gpRow({ OBJECT_NAME: "TWIN", NORAD_CAT_ID: "99999", TLE_LINE1: l1, TLE_LINE2: l2, PERIAPSIS: "549", APOAPSIS: "551" });
  const res = L.screenLaunchWindow(s, o, [...synthCatalog(50, T0, 700, 900, 5), twin], T0, 60);
  assert.equal(res.candidatesScreened, 1, "only the twin passes the prefilter");
  assert.notEqual(res.minutes[0].status, "GO");
  assert.equal(res.minutes[0].noradId, "99999");
  assert.ok(res.summary.go > 0, "later minutes open up as the plane rotates away");
});

test("compute budget: a 1 ms budget truncates with a consistent summary", () => {
  const res = L.screenLaunchWindow(L.LAUNCH_SITES[0], L.TARGET_ORBITS[0], synthCatalog(400, CAT_EPOCH, 500, 600, 3), T0, 120, { timeBudgetMs: 1 });
  assert.equal(res.truncated, true);
  assert.ok(res.minutes.length >= 1 && res.minutes.length < 120);
  assert.equal(res.summary.go + res.summary.caution + res.summary.noGo, res.minutes.length);
});

test("performance: 120 launch minutes against 2,000 in-band objects", () => {
  const sample = synthCatalog(2000, CAT_EPOCH, 530, 570, 21);
  const t0 = performance.now();
  const res = L.screenLaunchWindow(site("slc-40"), orbit("starlink-550"), sample, T0, 120);
  const ms = performance.now() - t0;
  assert.equal(res.truncated, false);
  assert.equal(res.candidatesScreened, 2000);
  // ~1 s on a laptop; the route's budget is 20 s. Generous bound for shared CI runners.
  assert.ok(ms < 10_000, `${ms.toFixed(0)} ms`);
});
