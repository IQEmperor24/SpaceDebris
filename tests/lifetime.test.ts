/* lib/lifetime.ts — orbital lifetime and FCC 5-year disposal compliance.
   Vallado exponential atmosphere (Table 8-4) x a crude solar-activity factor,
   circular-orbit decay da/dt = -sqrt(mu a) rho B integrated adaptively to 120 km.
   Checks the table, the units by hand, the 550 km Starlink-class anchor
   (~2.9 years at mean activity, ~5.8 y low, ~1.2 y high), monotonicity,
   convergence against a fixed-step RK4 reference, and runtime. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "@/lib/lifetime";
import { EARTH_EQUATORIAL_RADIUS_KM, MU_EARTH_KM3_S2 } from "@/lib/orbital";

const STARLINK_B = 0.04;
const EPOCH = new Date("2026-01-01T00:00:00Z");

test("atmosphere: exact at table rows", () => {
  for (const row of L.ATMOSPHERE_TABLE) {
    assert.equal(L.atmosphericDensity(row.altKm), row.rho0, `row ${row.altKm}`);
  }
  assert.equal(L.atmosphericDensity(400), 3.725e-12);
});

test("atmosphere: 550 km between 500 and 600 rows", () => {
  const r550 = L.atmosphericDensity(550);
  assert.ok(r550 < L.atmosphericDensity(500) && r550 > L.atmosphericDensity(600), `ρ(550)=${r550}`);
});

test("atmosphere: continuous at row boundaries (< 0.5 % jump) and monotone", () => {
  for (let i = 1; i < L.ATMOSPHERE_TABLE.length; i++) {
    const h = L.ATMOSPHERE_TABLE[i].altKm;
    const below = L.atmosphericDensity(h - 1e-9);
    const at = L.atmosphericDensity(h);
    const rel = Math.abs(below - at) / at;
    assert.ok(rel < 5e-3, `jump at ${h}: ${(rel * 100).toFixed(3)} %`);
  }
  let prev = Infinity;
  for (let h = 100; h <= 2000; h += 0.5) {
    const r = L.atmosphericDensity(h);
    assert.ok(r > 0 && r <= prev * (1 + 5e-3), `non-monotone at ${h}`);
    prev = r;
  }
});

test("atmosphere: below 150 uses 150 row, above 1000 extrapolates 1000 row, factor scales", () => {
  const r140 = L.atmosphericDensity(140);
  assert.ok(Math.abs(r140 - 2.07e-9 * Math.exp(10 / 22.523)) / r140 < 1e-12);
  const r1200 = L.atmosphericDensity(1200);
  assert.ok(Math.abs(r1200 - 3.019e-15 * Math.exp(-200 / 268)) / r1200 < 1e-12);
  assert.ok(Math.abs(L.atmosphericDensity(500, 2.5) - 2.5 * 6.967e-13) < 1e-25);
  assert.equal(L.atmosphericDensity(Number.NaN), 0);
  assert.equal(L.atmosphericDensity(500, 0), 0);
});

test("activityFromF107 buckets", () => {
  assert.equal(L.activityFromF107(null), "MEAN");
  assert.equal(L.activityFromF107(Number.NaN), "MEAN");
  assert.equal(L.activityFromF107(70), "LOW");
  assert.equal(L.activityFromF107(99.9), "LOW");
  assert.equal(L.activityFromF107(100), "MEAN");
  assert.equal(L.activityFromF107(158), "MEAN");
  assert.equal(L.activityFromF107(160), "HIGH");
  assert.equal(L.activityFromF107(250), "HIGH");
});

test("presets match spec", () => {
  const ids = L.BALLISTIC_PRESETS.map((p) => `${p.id}:${p.bcM2PerKg}`);
  assert.deepEqual(ids, ["starlink:0.04", "cubesat-3u:0.03", "bus-1000kg:0.012", "dense-debris:0.005"]);
  assert.equal(L.BALLISTIC_PRESETS[0].label, "Starlink-class (B 0.04 m²/kg)");
});

test("decay-rate units: hand calculation at 550 km", () => {
  const a = EARTH_EQUATORIAL_RADIUS_KM + 550;
  const rho = L.atmosphericDensity(550);
  // km/s = sqrt(km^3/s^2 * km) * (kg/m^3 * 1e9 m^3/km^3) * (m^2/kg * 1e-6 km^2/m^2)
  const expectedKmPerDay = Math.sqrt(MU_EARTH_KM3_S2 * a) * rho * 1e9 * STARLINK_B * 1e-6 * 86400;
  const got = L.circularDecayRateKmPerDay(550, STARLINK_B);
  assert.ok(Math.abs(got - expectedKmPerDay) / expectedKmPerDay < 1e-12);
  // Inverse round-trip
  const bBack = L.impliedBallisticCoefficient(550, got, 1);
  assert.ok(bBack !== null && Math.abs(bBack - STARLINK_B) < 1e-12);
  assert.equal(L.impliedBallisticCoefficient(550, -0.01, 1), null);
  assert.equal(L.impliedBallisticCoefficient(100, 0.01, 1), null);
});

test("Starlink preset at 550 km: ~2.9 y MEAN, and the activity factor scales lifetime inversely", () => {
  const r = L.estimateLifetime(550, STARLINK_B, "MEAN", EPOCH);
  assert.equal(r.capped, false);
  // Anchor quoted in README.md and shown on the Disposal Compliance panel (MEAN 2.9 y).
  assert.ok(r.lifetimeYears !== null && r.lifetimeYears > 2.5 && r.lifetimeYears < 3.5, `MEAN ${r.lifetimeYears} y`);
  // Density is multiplied by 0.5 / 1 / 2.5, so lifetime is 2x MEAN at LOW and MEAN / 2.5 at HIGH.
  const lo = L.estimateLifetime(550, STARLINK_B, "LOW", EPOCH).lifetimeYears;
  const hi = L.estimateLifetime(550, STARLINK_B, "HIGH", EPOCH).lifetimeYears;
  assert.ok(lo !== null && Math.abs(lo / r.lifetimeYears - 2) < 0.02, `LOW ${lo} y`);
  assert.ok(hi !== null && Math.abs(r.lifetimeYears / hi - 2.5) < 0.025, `HIGH ${hi} y`);
  assert.equal(L.fccFiveYearCheck(r.lifetimeYears).pass, r.lifetimeYears <= 5);
  assert.ok(L.legacy25YearCheck(r.lifetimeYears).pass);
  // reentryDate consistent with lifetime
  const dtYears = (Date.parse(r.reentryDate as string) - EPOCH.getTime()) / (365.25 * 86400e3);
  assert.ok(Math.abs(dtYears - (r.lifetimeYears as number)) < 1e-6);
});

test("400 km < 2 y, 300 km < 0.5 y, 800 km > 50 y, 1000 km capped or > 300 y", () => {
  const r400 = L.estimateLifetime(400, STARLINK_B, "MEAN", EPOCH);
  const r300 = L.estimateLifetime(300, STARLINK_B, "MEAN", EPOCH);
  const r800 = L.estimateLifetime(800, STARLINK_B, "MEAN", EPOCH);
  const r1000 = L.estimateLifetime(1000, STARLINK_B, "MEAN", EPOCH);
  assert.ok(r400.lifetimeYears !== null && r400.lifetimeYears < 2);
  assert.ok(r300.lifetimeYears !== null && r300.lifetimeYears < 0.5);
  assert.ok(r800.lifetimeYears === null || r800.lifetimeYears > 50);
  assert.ok(r1000.capped || (r1000.lifetimeYears !== null && r1000.lifetimeYears > 300));
  assert.equal(L.fccFiveYearCheck(r1000.lifetimeYears).pass, false);
  assert.equal(L.legacy25YearCheck(r1000.lifetimeYears).pass, false);
  assert.ok(L.fccFiveYearCheck(r400.lifetimeYears).pass);
});

test("HIGH activity shorter than MEAN shorter than LOW", () => {
  for (const alt of [400, 550, 700]) {
    const lo = L.estimateLifetime(alt, STARLINK_B, "LOW", EPOCH).lifetimeYears;
    const me = L.estimateLifetime(alt, STARLINK_B, "MEAN", EPOCH).lifetimeYears;
    const hi = L.estimateLifetime(alt, STARLINK_B, "HIGH", EPOCH).lifetimeYears;
    assert.ok(hi !== null && me !== null && lo !== null);
    assert.ok(hi < me && me < lo);
  }
});

test("larger B decays faster", () => {
  const dense = L.estimateLifetime(500, 0.005, "MEAN", EPOCH).lifetimeYears;
  const star = L.estimateLifetime(500, 0.04, "MEAN", EPOCH).lifetimeYears;
  assert.ok(dense !== null && star !== null && star < dense);
  // Lifetime ∝ 1/B in this model (density profile fixed): ratio ≈ 8.
  const ratio = dense / star;
  assert.ok(Math.abs(ratio - 8) / 8 < 0.02, `ratio ${ratio}`);
});

test("ladder monotone (null = +∞ and stays null)", () => {
  for (const preset of L.BALLISTIC_PRESETS) {
    for (const act of L.SOLAR_ACTIVITY_LEVELS) {
      const ladder = L.lifetimeLadder(preset.bcM2PerKg, act);
      assert.equal(ladder.length, L.DEFAULT_LADDER_ALTITUDES_KM.length);
      let prev = -1;
      let sawNull = false;
      for (const row of ladder) {
        if (row.lifetimeYears === null) {
          sawNull = true;
          continue;
        }
        assert.ok(!sawNull, `${preset.id}/${act}: finite after capped at ${row.altKm}`);
        assert.ok(row.lifetimeYears > prev, `${preset.id}/${act}: not increasing at ${row.altKm}`);
        prev = row.lifetimeYears;
      }
    }
  }
});

test("curve: ≤ 200 samples, monotone, starts at start alt, ends ≤ 120 km when not capped", () => {
  const cases: Array<[number, number, L.SolarActivity]> = [
    [550, 0.04, "MEAN"],
    [300, 0.04, "HIGH"],
    [700, 0.005, "LOW"],
    [1000, 0.012, "MEAN"],
    [35786, 0.04, "MEAN"],
    [125, 0.04, "MEAN"],
  ];
  for (const [alt, b, act] of cases) {
    const r = L.estimateLifetime(alt, b, act, EPOCH);
    assert.ok(r.curve.length >= 1 && r.curve.length <= L.CURVE_MAX_SAMPLES, `${alt}: ${r.curve.length} samples`);
    assert.equal(r.curve[0].years, 0);
    assert.equal(r.curve[0].altKm, alt);
    for (let i = 1; i < r.curve.length; i++) {
      assert.ok(r.curve[i].years > r.curve[i - 1].years, `${alt}: time not increasing at ${i}`);
      assert.ok(r.curve[i].altKm <= r.curve[i - 1].altKm + 1e-9, `${alt}: altitude rose at ${i}`);
      assert.ok(Number.isFinite(r.curve[i].years) && Number.isFinite(r.curve[i].altKm));
    }
    const last = r.curve[r.curve.length - 1];
    if (!r.capped) {
      assert.ok(last.altKm <= 120, `${alt}: ends at ${last.altKm}`);
      assert.ok(Math.abs(last.years - (r.lifetimeYears as number)) < 1e-9);
    } else {
      assert.ok(Math.abs(last.years - L.LIFETIME_CAP_YEARS) < 1e-9, `${alt}: capped curve ends at ${last.years}`);
      assert.equal(r.lifetimeYears, null);
      assert.equal(r.reentryDate, null);
    }
  }
});

test("edge cases: at/below 120 km, B = 0, bad input", () => {
  const r = L.estimateLifetime(110, 0.04, "MEAN", EPOCH);
  assert.equal(r.lifetimeYears, 0);
  assert.equal(r.capped, false);
  assert.equal(r.reentryDate, EPOCH.toISOString());
  const z = L.estimateLifetime(550, 0, "MEAN", EPOCH);
  assert.equal(z.capped, true);
  assert.equal(z.lifetimeYears, null);
  assert.throws(() => L.estimateLifetime(Number.NaN, 0.04, "MEAN"), RangeError);
  assert.throws(() => L.estimateLifetime(550, -1, "MEAN"), RangeError);
  assert.throws(() => L.estimateLifetime(550, Number.POSITIVE_INFINITY, "MEAN"), RangeError);
  // custom cap
  const c = L.estimateLifetime(800, 0.04, "MEAN", EPOCH, 10);
  assert.equal(c.capped, true);
  assert.ok(Math.abs(c.curve[c.curve.length - 1].years - 10) < 1e-9);
  // extreme B upper bound still terminates cleanly
  const big = L.estimateLifetime(400, L.BC_MAX_M2_PER_KG, "HIGH", EPOCH);
  assert.ok(big.lifetimeYears !== null && big.lifetimeYears > 0 && Number.isFinite(big.lifetimeYears));
});

test("convergence: adaptive integrator agrees with a fixed-step RK4 reference to < 0.5 %", () => {
  // Reference: brute-force fixed-step RK4 with 600 s steps (550 km).
  const B = 0.04;
  const f = (a: number) => -Math.sqrt(MU_EARTH_KM3_S2 * a) * L.atmosphericDensity(a - EARTH_EQUATORIAL_RADIUS_KM) * 1e3 * B;
  let a = EARTH_EQUATORIAL_RADIUS_KM + 550;
  let t = 0;
  const dt = 600;
  while (a - EARTH_EQUATORIAL_RADIUS_KM > 120) {
    const k1 = f(a), k2 = f(a + 0.5 * dt * k1), k3 = f(a + 0.5 * dt * k2), k4 = f(a + dt * k3);
    const an = a + (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    if (an - EARTH_EQUATORIAL_RADIUS_KM <= 120) {
      t += dt * ((a - EARTH_EQUATORIAL_RADIUS_KM - 120) / (a - an));
      break;
    }
    a = an;
    t += dt;
  }
  const refYears = t / (365.25 * 86400);
  const r = L.estimateLifetime(550, B, "MEAN", EPOCH);
  const rel = Math.abs((r.lifetimeYears as number) - refYears) / refYears;
  assert.ok(rel < 5e-3);
});

test("runtime < 200 ms per estimate (worst case: capped 500 y)", () => {
  const worst: Array<[number, number]> = [[1000, 0.005], [35786, 0.04], [550, 0.04], [300, 1]];
  for (const [alt, b] of worst) {
    const t0 = performance.now();
    const r = L.estimateLifetime(alt, b, "LOW", EPOCH);
    const ms = performance.now() - t0;
    assert.ok(r.steps > 0);
    assert.ok(ms < 200, `${alt} km, B ${b}: ${ms.toFixed(1)} ms (interactive slider budget)`);
  }
  const t0 = performance.now();
  for (const p of L.BALLISTIC_PRESETS) for (const act of L.SOLAR_ACTIVITY_LEVELS) L.lifetimeLadder(p.bcM2PerKg, act);
  const ladderMs = (performance.now() - t0) / 12;
  assert.ok(ladderMs < 200, `ladder ${ladderMs.toFixed(1)} ms`);
});

test("disposal checks + format helpers", () => {
  assert.deepEqual(L.fccFiveYearCheck(4.9), { rule: "FCC 5-year post-mission disposal (2022)", pass: true });
  assert.equal(L.fccFiveYearCheck(5).pass, true);
  assert.equal(L.fccFiveYearCheck(5.01).pass, false);
  assert.equal(L.fccFiveYearCheck(null).pass, false);
  assert.equal(L.fccFiveYearCheck(Number.NaN).pass, false);
  assert.deepEqual(L.legacy25YearCheck(24), { rule: "IADC / NASA 25-year guideline", pass: true });
  assert.equal(L.legacy25YearCheck(26).pass, false);
  assert.equal(L.legacy25YearCheck(null).pass, false);
  assert.equal(L.formatLifetime(null), "> 500 y");
  assert.equal(L.formatLifetime(3.456), "3.5 y");
  assert.equal(L.formatLifetime(0.05), "18 d");
  assert.equal(L.formatLifetime(0.001), "< 1 d");
  assert.equal(L.formatLifetime(Number.NaN), "—");
  assert.equal(L.formatReentryMonth("2029-04-15T00:00:00.000Z"), "2029-04");
  assert.equal(L.formatReentryMonth("2029-11-30T23:59:59.000Z"), "2029-11");
  assert.equal(L.formatReentryMonth(null), "—");
  assert.equal(L.formatReentryMonth("garbage"), "—");
  assert.equal(L.inStarlinkShellBand(550), true);
  assert.equal(L.inStarlinkShellBand(525), true);
  assert.equal(L.inStarlinkShellBand(600), false);
  assert.equal(L.inStarlinkShellBand(Number.NaN), false);
  assert.equal(L.findBallisticPreset("starlink")?.bcM2PerKg, 0.04);
  assert.equal(L.findBallisticPreset("nope"), null);
});
