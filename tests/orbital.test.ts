/* lib/orbital.ts — the shared physics layer every panel builds on.
   Anchored to an ISS-like synthetic element set (51.64 deg, ~420 km,
   epoch 2024-01-01 12:00 UTC; checksums not valid, which satellite.js
   does not check), so SGP4 results are checked against plausibility
   ranges, not a reference ephemeris. Analytic checks for the
   probability of collision, two-body propagation and launch geometry. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as O from "@/lib/orbital";

const L1 = "1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9993";
const L2 = "2 25544  51.6400 208.9163 0006703 130.5360 325.0288 15.49560532 25002";
const EPOCH = new Date("2024-01-01T12:00:00Z");

const approx = (actual: number, expected: number, tol: number, label = ""): void => {
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ${expected} ± ${tol}, got ${actual}`);
};

function issSatrec() {
  const satrec = O.parseTle(L1, L2);
  assert.ok(satrec, "ISS TLE must parse");
  return satrec;
}
function issElements() {
  const el = O.tleElements({ TLE_LINE1: L1, TLE_LINE2: L2, NORAD_CAT_ID: "25544", OBJECT_NAME: "ISS (ZARYA)" });
  assert.ok(el, "ISS elements must derive");
  return el;
}
function issState() {
  const sv = O.propagateAt(issSatrec(), EPOCH);
  assert.ok(sv, "ISS propagates at epoch");
  return sv;
}

test("time: Julian date, GMST, day-of-year and formatters", () => {
  approx(O.dateToJulian(new Date("2000-01-01T12:00:00Z")), 2451545.0, 1e-9, "JD J2000");
  approx(O.julianToDate(2451545.0).getTime(), Date.parse("2000-01-01T12:00:00Z"), 1, "JD round trip");
  approx(O.gmstHours(new Date("2000-01-01T12:00:00Z")), 18.697, 0.01, "GMST at J2000");
  assert.equal(O.dayOfYear(new Date("2026-10-10T00:00:00Z")), 283);
  assert.equal(O.formatHoursHms(18.697374558), "18:41:50");
  assert.equal(O.formatDuration(2 * 3_600_000 + 14 * 60_000), "2h 14m");
  assert.equal(O.normalizeDeg180(190), -170);
  assert.equal(O.normalizeDeg180(-190), 170);
  assert.equal(O.normalizeDeg180(180), 180);
});

test("TLE parsing: ISS-like fixture elements are recovered (51.64°, ~420 km, n-dot/2, B*)", () => {
  assert.equal(O.parseTle("garbage", "lines"), null);
  const el = issElements();
  approx(el.periodMinutes, 92.93, 0.2, "period");
  approx(el.inclinationDeg, 51.64, 0.001, "inclination");
  assert.ok(el.perigeeKm > 395 && el.perigeeKm < 430, `perigee ${el.perigeeKm}`);
  assert.ok(el.apogeeKm > 400 && el.apogeeKm < 435, `apogee ${el.apogeeKm}`);
  // satellite.js 5.0.0 stores the RAW ndot field; the lib parses n-dot/2 from line 1.
  approx(el.ndotHalfRevPerDay2, 0.00016717, 1e-9, "n-dot/2");
  approx(el.bstar, 0.1027e-3, 1e-9, "B*");
  approx(el.epoch.getTime(), EPOCH.getTime(), 1000, "epoch");
});

test("SGP4 propagation: altitude, speed and geodetic sub-point are physical", () => {
  const sv = issState();
  const alt = O.altitudeKmFromEci(sv.position);
  assert.ok(alt > 395 && alt < 435, `altitude ${alt}`);
  approx(O.speedKmS(sv.velocity), 7.66, 0.05, "speed");
  const gd = O.geodeticFromEci(sv.position, EPOCH);
  assert.ok(Math.abs(gd.latitudeDeg) <= 51.7 && Math.abs(gd.longitudeDeg) <= 180);
  assert.ok(gd.altitudeKm > 395 && gd.altitudeKm < 435, `geodetic height ${gd.altitudeKm}`);
  // Error paths never leak NaN: bad input -> null, far future -> null or finite.
  const satrec = issSatrec();
  assert.equal(O.propagateMinutes(satrec, Number.NaN), null);
  const far = O.propagateMinutes(satrec, 50 * 365 * 1440);
  assert.ok(far === null || far.position.every(Number.isFinite));
});

test("RIC frame is orthonormal, right-handed and in-track follows velocity", () => {
  const sv = issState();
  const f = O.ricFrame(sv.position, sv.velocity);
  approx(O.vDot(f.radial, f.inTrack), 0, 1e-9, "R.I");
  approx(O.vDot(f.radial, f.crossTrack), 0, 1e-9, "R.C");
  approx(O.vDot(f.inTrack, f.crossTrack), 0, 1e-9, "I.C");
  approx(O.vNorm(f.radial), 1, 1e-9, "|R|");
  approx(O.vNorm(f.inTrack), 1, 1e-9, "|I|");
  approx(O.vDot(O.vCross(f.radial, f.inTrack), f.crossTrack), 1, 1e-9, "R x I = C");
  assert.ok(O.vDot(f.inTrack, O.vUnit(sv.velocity)) > 0.999);
  const disp = O.vAdd(O.vAdd(O.vScale(f.radial, 1), O.vScale(f.inTrack, 2)), O.vScale(f.crossTrack, 3));
  const ric = O.toRic(disp, f);
  approx(ric.radialKm, 1, 1e-9, "R");
  approx(ric.inTrackKm, 2, 1e-9, "I");
  approx(ric.crossTrackKm, 3, 1e-9, "C");
});

test("look angles: ISS rises above 10 degrees over JSC Houston within 24 h", () => {
  const satrec = issSatrec();
  const sv = issState();
  const la = O.lookAngles(O.JSC_SITE, sv.position, EPOCH);
  assert.ok(la.azimuthDeg >= 0 && la.azimuthDeg < 360);
  assert.ok(la.elevationDeg >= -90 && la.elevationDeg <= 90);
  assert.ok(la.rangeKm > 300 && la.rangeKm < 15000);
  let maxEl = -90;
  for (let m = 0; m < 1440; m += 0.5) {
    const s = O.propagateMinutes(satrec, m);
    if (!s) continue;
    const el = O.lookAngles(O.JSC_SITE, s.position, new Date(EPOCH.getTime() + m * 60_000)).elevationDeg;
    if (el > maxEl) maxEl = el;
  }
  assert.ok(maxEl > 10, `max elevation ${maxEl}`);
});

test("catalog helpers: shells, launch designators, object classes", () => {
  assert.equal(O.meanAltitudeKm({ APOAPSIS: "420", PERIAPSIS: "410" }), 415);
  assert.ok(Number.isNaN(O.meanAltitudeKm({ APOAPSIS: "x", PERIAPSIS: "1" })));
  assert.equal(O.classifyShell(400), "LEO");
  assert.equal(O.classifyShell(20200), "MEO");
  assert.equal(O.classifyShell(35786), "GEO");
  assert.equal(O.launchDesignator("1998-067A"), "1998-067");
  assert.equal(O.launchDesignator("1999-025DEV"), "1999-025");
  assert.equal(O.launchDesignator("bad"), null);
  assert.equal(O.launchDesignator(undefined), null);
  assert.equal(O.classifyObjectName("COSMOS 2251 DEB"), "DEBRIS");
  assert.equal(O.classifyObjectName("SL-16 R/B"), "ROCKET BODY");
  assert.equal(O.classifyObjectName("STARLINK-1234"), "PAYLOAD");
  assert.equal(O.classifyObjectName("TBA - TO BE ASSIGNED"), "UNKNOWN");
});

test("decay estimate: ISS loses tens of metres per day; orbit raising has no lifetime", () => {
  const el = issElements();
  const dec = O.decayEstimate(el);
  assert.ok(dec.decayKmPerDay > 0.03 && dec.decayKmPerDay < 0.3, `decay ${dec.decayKmPerDay} km/day`);
  assert.ok((dec.estimatedLifetimeDays ?? 0) > 1000);
  assert.equal(O.decayEstimate({ ...el, ndotHalfRevPerDay2: -0.0001 }).estimatedLifetimeDays, null);
});

test("probability of collision matches the analytic isotropic encounter", () => {
  const sv = issState();
  const f = O.ricFrame(sv.position, sv.velocity);
  const sigma: O.Vec3 = [1, 1, 1];
  const primary: O.PcObjectState = { position: sv.position, velocity: sv.velocity, sigmaRicKm: sigma };
  const headOn = (offsetKm: number): O.PcObjectState => ({
    position: O.vAdd(sv.position, O.vScale(f.radial, offsetKm)),
    velocity: O.vScale(sv.velocity, -1),
    sigmaRicKm: sigma,
  });
  const hbr = 0.02;
  // Combined variance per axis = 2 sigma^2. Exact for a zero miss: 1 - exp(-HBR^2 / (2 * 2 sigma^2)).
  const pc0 = O.probabilityOfCollision({ primary, secondary: headOn(0), hardBodyRadiusKm: hbr });
  approx(pc0, 1 - Math.exp(-(hbr * hbr) / 4), 2e-6, "Pc(miss 0)");
  const pc1 = O.probabilityOfCollision({ primary, secondary: headOn(1), hardBodyRadiusKm: hbr });
  approx(pc1, 1e-4 * Math.exp(-0.25), 2e-6, "Pc(miss 1 km)");
  const pc10 = O.probabilityOfCollision({ primary, secondary: headOn(10), hardBodyRadiusKm: hbr });
  assert.ok(pc10 < 1e-12, `Pc(miss 10 km) ${pc10}`);
  assert.equal(O.probabilityOfCollision({ primary, secondary: headOn(0), hardBodyRadiusKm: 0 }), 0);
  assert.equal(O.probabilityOfCollision({ primary, secondary: { ...primary }, hardBodyRadiusKm: hbr }), 0);
  for (const pc of [pc0, pc1, pc10]) assert.ok(pc >= 0 && pc <= 1);
});

test("Pc respects anisotropic covariance: closed form per axis, and swapping sigma flips the order", () => {
  // Primary at [r,0,0] moving +y, so its R/I/C axes are x/y/z. The secondary moves [0,v,v]:
  // the relative velocity is purely cross-track, so both 1 km misses lie fully in the encounter
  // (x-y) plane. The secondary's in-track axis is tilted 45 deg out of that plane, so the combined
  // encounter-plane variances are x: 2 sR^2 and y: sI^2 + (sI^2 + sC^2) / 2.
  const r = 6778;
  const v = 7.66;
  const hbr = 0.02;
  const pcPair = (sig: O.Vec3) => {
    const primary: O.PcObjectState = { position: [r, 0, 0], velocity: [0, v, 0], sigmaRicKm: sig };
    const crossing = (pos: O.Vec3): O.PcObjectState => ({ position: pos, velocity: [0, v, v], sigmaRicKm: sig });
    const radial = O.probabilityOfCollision({ primary, secondary: crossing([r + 1, 0, 0]), hardBodyRadiusKm: hbr });
    const inTrack = O.probabilityOfCollision({ primary, secondary: crossing([r, 1, 0]), hardBodyRadiusKm: hbr });
    // Small-HBR closed form: Pc ~ HBR^2 / (2 sx sy) * exp(-d^2 / (2 s_axis^2)), d = 1 km.
    const [sR, sI, sC] = sig;
    const varX = 2 * sR * sR;
    const varY = sI * sI + (sI * sI + sC * sC) / 2;
    const pre = (hbr * hbr) / (2 * Math.sqrt(varX * varY));
    approx(radial / (pre * Math.exp(-1 / (2 * varX))), 1, 0.01, `radial Pc vs closed form, sigma ${sig}`);
    approx(inTrack / (pre * Math.exp(-1 / (2 * varY))), 1, 0.01, `in-track Pc vs closed form, sigma ${sig}`);
    return { radial, inTrack };
  };
  const tight = pcPair([0.3, 1.0, 0.3]);
  assert.ok(tight.radial < tight.inTrack / 5, `radial ${tight.radial} should be << in-track ${tight.inTrack}`);
  const swapped = pcPair([1.0, 0.3, 1.0]);
  assert.ok(swapped.radial > swapped.inTrack, `swapped sigma: radial ${swapped.radial} should be > in-track ${swapped.inTrack}`);
});

test("circular orbit state: radius, speed, inclination and argument of latitude", () => {
  const st = O.circularOrbitState({ altitudeKm: 550, inclinationDeg: 53, raanDeg: 40, argLatDeg: 30 });
  const r = O.vNorm(st.position);
  approx(r, O.EARTH_EQUATORIAL_RADIUS_KM + 550, 1e-6, "radius");
  approx(O.vNorm(st.velocity), Math.sqrt(O.MU_EARTH_KM3_S2 / r), 1e-9, "circular speed");
  approx(O.vDot(st.position, st.velocity), 0, 1e-6, "r . v");
  const h = O.vCross(st.position, st.velocity);
  approx((Math.acos(h[2] / O.vNorm(h)) * 180) / Math.PI, 53, 1e-6, "inclination");
  approx(O.argumentOfLatitude(st.position, 53, 40), 30, 1e-6, "argument of latitude");
});

test("two-body propagation (universal variables): period, energy, momentum, reversibility", () => {
  const st = O.circularOrbitState({ altitudeKm: 550, inclinationDeg: 53, raanDeg: 40, argLatDeg: 30 });
  const r = O.vNorm(st.position);
  const v = O.vNorm(st.velocity);
  const T = (2 * Math.PI) / O.meanMotionRadPerSec(r);
  const back = O.twoBodyPropagate(st, T);
  assert.ok(back);
  assert.ok(O.vNorm(O.vSub(back.position, st.position)) < 1e-3, "one period returns to start (< 1 m)");
  const q = O.twoBodyPropagate(st, T / 4);
  assert.ok(q);
  approx(O.vDot(O.vUnit(q.position), O.vUnit(st.position)), 0, 1e-6, "quarter period is 90 deg ahead");
  const energy = (s: O.StateVector): number => O.vNorm(s.velocity) ** 2 / 2 - O.MU_EARTH_KM3_S2 / O.vNorm(s.position);
  approx(energy(q), v * v / 2 - O.MU_EARTH_KM3_S2 / r, 1e-9, "energy");

  const ell: O.StateVector = { position: [7000, 0, 0], velocity: [0, Math.sqrt(O.MU_EARTH_KM3_S2 / 7000) * 1.14, 0.5] };
  const e1 = O.twoBodyPropagate(ell, 15000);
  assert.ok(e1);
  approx(energy(e1), energy(ell), 1e-9 * Math.abs(energy(ell)), "elliptical energy");
  approx(O.vNorm(O.vCross(e1.position, e1.velocity)), O.vNorm(O.vCross(ell.position, ell.velocity)), 1e-6, "h");
  const fwd = O.twoBodyPropagate(ell, 3000);
  assert.ok(fwd);
  const bk = O.twoBodyPropagate(fwd, -3000);
  assert.ok(bk);
  assert.ok(O.vNorm(O.vSub(bk.position, ell.position)) < 1e-6, "backward inverts forward");

  const hp = O.twoBodyPropagate({ position: [7000, 0, 0], velocity: [0, 12, 0] }, 2000);
  assert.ok(hp && O.vNorm(hp.position) > 7000, "hyperbolic case converges");
  const zero = O.twoBodyPropagate(st, 0);
  assert.ok(zero);
  assert.equal(zero.position[0], st.position[0]);
});

test("launch geometry: site ECI, plane through the site, ascending pass", () => {
  const date = new Date("2026-10-19T12:00:00Z");
  const site = O.siteEci(O.JSC_SITE, date);
  approx(O.vNorm(site), 6372.5, 2, "site radius");
  const zenith: O.Vec3 = O.vScale(O.vUnit(site), O.vNorm(site) + 400);
  assert.ok(O.lookAngles(O.JSC_SITE, zenith, date).elevationDeg > 89.7, "point above the site is at zenith");

  const raan = O.raanThroughPosition(site, 53);
  assert.ok(raan !== null && raan >= 0 && raan < 360, `raan ${raan}`);
  const i = (53 * Math.PI) / 180;
  const om = (raan * Math.PI) / 180;
  const normal: O.Vec3 = [Math.sin(i) * Math.sin(om), -Math.sin(i) * Math.cos(om), Math.cos(i)];
  assert.ok(Math.abs(O.vDot(normal, site)) < 1e-6 * O.vNorm(site), "site lies in the orbit plane");
  const u = O.argumentOfLatitude(site, 53, raan);
  assert.ok(u > 0 && u < 90, `ascending pass for a northern site, u = ${u}`);
  const st = O.circularOrbitState({ altitudeKm: 0, inclinationDeg: 53, raanDeg: raan, argLatDeg: u });
  assert.ok(O.vDot(O.vUnit(st.position), O.vUnit(site)) > 0.999999);
  assert.ok(st.velocity[2] > 0, "velocity heads north");
  assert.equal(O.raanThroughPosition(site, 20), null, "no plane when inclination < site latitude");
});

test("thresholds: NASA ISS and Starlink public Pc values", () => {
  assert.equal(O.ISS_PC_RED_THRESHOLD, 1e-4);
  assert.equal(O.ISS_PC_YELLOW_THRESHOLD, 1e-5);
  assert.equal(O.STARLINK_PC_MANEUVER_THRESHOLD, 3e-7, "SpaceX semiannual FCC report, July 2026");
  assert.deepEqual({ ...O.ISS_KEEP_OUT_BOX_KM }, { radial: 2, inTrack: 25, crossTrack: 25 });
});

test("performance: SGP4 throughput stays in the microsecond range", () => {
  const satrec = issSatrec();
  const n = 100_000;
  let ok = 0;
  const t0 = performance.now();
  for (let k = 0; k < n; k++) if (O.propagateMinutes(satrec, k * 0.01)) ok++;
  const usPerCall = ((performance.now() - t0) * 1000) / n;
  assert.equal(ok, n);
  // Typically ~0.5-2 us on a laptop; the bound is generous so shared CI runners never flake.
  assert.ok(usPerCall < 25, `${usPerCall.toFixed(2)} us per propagation`);
});
