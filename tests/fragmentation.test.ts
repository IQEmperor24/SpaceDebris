/* lib/fragmentation.ts — breakup-family grouping by launch designator with
   two-factor attribution (designator AND name pattern) to 11 catalogued events. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "@/lib/fragmentation";
import type { SpaceTrackTLE } from "@/lib/spacetrack";
import { gpRow } from "./fixtures";

/** A gp row carrying only the fields groupFamilies reads. */
const mk = (id: string, name: string, apo = "850", peri = "830", inc = "98.5"): SpaceTrackTLE =>
  gpRow({ OBJECT_ID: id, OBJECT_NAME: name, APOAPSIS: apo, PERIAPSIS: peri, INCLINATION: inc });

test("catalog: 11 events, unique designators, non-global patterns that match their parent", () => {
  assert.equal(F.BREAKUP_CATALOG.length, 11);
  assert.equal(new Set(F.BREAKUP_CATALOG.map((e) => e.launchDesignator)).size, 11);
  for (const e of F.BREAKUP_CATALOG) {
    assert.match(e.launchDesignator, /^\d{4}-\d{3}$/);
    assert.match(e.eventDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(e.approxCatalogedFragments) && e.approxCatalogedFragments > 0);
    assert.ok(Number.isFinite(e.approxAltitudeKm) && e.approxAltitudeKm > 0);
    assert.equal(e.nameMatch.global, false, `${e.parentName}: a /g regex is stateful across test() calls`);
    assert.ok(e.nameMatch.test(e.parentName), `${e.parentName} matches its own pattern`);
    assert.ok(e.note.length > 10);
  }
  const fy = F.BREAKUP_CATALOG.find((e) => e.launchDesignator === "1999-025");
  assert.ok(fy);
  assert.equal(fy.parentName, "FENGYUN 1C");
  assert.equal(fy.eventType, "ASAT");
  assert.equal(fy.approxCatalogedFragments, 3500);
});

test("two-factor attribution: right designator AND right name -> attributed", () => {
  const objs = ["AAA", "AAB", "AAC", "AAD", "AAE"].map((s) => mk(`1999-025${s}`, "FENGYUN 1C DEB", "870", "840", "98.8"));
  const r = F.groupFamilies(objs);
  assert.deepEqual([r.totalObjects, r.debrisObjects, r.attributedDebrisObjects, r.catalogEventsPresent], [5, 5, 5, 1]);
  assert.equal(r.families.length, 1);
  const fam = r.families[0];
  assert.equal(fam.launchDesignator, "1999-025");
  assert.equal(fam.parentName, "FENGYUN 1C");
  assert.equal(fam.debrisCount, 5);
  assert.ok(Math.abs(fam.shareOfSample - 1) < 1e-12);
  assert.equal(fam.event?.eventType, "ASAT");
  assert.equal(fam.meanAltitudeKm, 855);
  assert.ok(fam.meanInclinationDeg !== null && Math.abs(fam.meanInclinationDeg - 98.8) < 1e-9);
  assert.equal(fam.shell, "LEO");
});

test("two-factor attribution: right designator but WRONG name -> never mislabelled", () => {
  const r = F.groupFamilies(["X", "Y", "Z"].map((s) => mk(`1999-025${s}`, "SOMETHING ELSE")));
  const fam = r.families[0];
  assert.equal(fam.event, null);
  assert.equal(fam.parentName, "SOMETHING ELSE");
  assert.equal(r.attributedDebrisObjects, 0);
  assert.equal(r.catalogEventsPresent, 0);
  assert.equal(F.attributeBreakupEvent("1999-025", ["SOMETHING ELSE"]), null);
  assert.ok(F.attributeBreakupEvent("1999-025", ["FENGYUN 1C DEB"]));
  assert.equal(F.attributeBreakupEvent("2099-999", ["FENGYUN 1C DEB"]), null);
});

test("singletons are dropped from families but counted in sample totals", () => {
  const r = F.groupFamilies([mk("1990-001A", "LONELY SAT"), mk("1992-093A", "SL-16 R/B"), mk("1992-093B", "SL-16 DEB")]);
  assert.equal(r.totalObjects, 3);
  assert.equal(r.debrisObjects, 1);
  assert.deepEqual(r.families.map((f) => f.launchDesignator), ["1992-093"]);
});

test("parent names: DEB / R/B suffixes stripped; most frequent name wins, ties to first seen", () => {
  const r = F.groupFamilies([mk("1992-093A", "SL-16 R/B"), mk("1992-093B", "SL-16 DEB"), mk("1992-093C", "SL-16 DEB")]);
  assert.equal(r.families[0].parentName, "SL-16");
  assert.equal(r.families[0].debrisCount, 2);
  assert.equal(F.stripObjectSuffix("FENGYUN 1C DEB"), "FENGYUN 1C");
  assert.equal(F.stripObjectSuffix("SL-16 R/B"), "SL-16");
  assert.equal(F.stripObjectSuffix("FOO R/B DEB"), "FOO");
  assert.equal(F.stripObjectSuffix("SL-12 R/B(2)"), "SL-12");
  assert.equal(F.stripObjectSuffix("SL-12 R/B(2) DEB"), "SL-12");
  assert.equal(F.stripObjectSuffix("DEB"), "DEB", "never collapses to empty");
  assert.equal(F.deriveParentName(["STARLINK-1", "STARLINK-2"]), "STARLINK-1");
  assert.equal(F.deriveParentName(["B SAT", "A SAT", "A SAT"]), "A SAT");
  assert.equal(F.deriveParentName(["B SAT", "A SAT"]), "B SAT");
  assert.equal(F.deriveParentName([]), "UNKNOWN");
});

test("Space-Track empty strings / NaN never leak into family statistics", () => {
  const r = F.groupFamilies([
    mk("2001-001A", "SAT A", "800", "700", "51.6"),
    mk("2001-001B", "SAT A DEB", "", "", ""),
    mk("2001-001C", "SAT A DEB", "null", "abc", "NaN"),
    mk("2001-001D", "SAT A DEB", "1000", "900", "52.0"),
    mk("2002-002A", "SAT B", "", "", ""),
    mk("2002-002B", "SAT B DEB", "x", "y", "z"),
  ]);
  const a = r.families.find((f) => f.launchDesignator === "2001-001");
  const b = r.families.find((f) => f.launchDesignator === "2002-002");
  assert.ok(a && b);
  assert.equal(a.meanAltitudeKm, 850);
  assert.ok(a.meanInclinationDeg !== null && Math.abs(a.meanInclinationDeg - 51.8) < 1e-9);
  assert.equal(a.shell, "LEO");
  assert.deepEqual([b.meanAltitudeKm, b.meanInclinationDeg, b.shell], [null, null, null]);
  for (const f of r.families) {
    assert.ok(f.meanAltitudeKm === null || Number.isFinite(f.meanAltitudeKm));
    assert.ok(Number.isFinite(f.shareOfSample));
  }
});

test("sorting: debris-bearing families first, then by count; the cap never changes totals", () => {
  const objs: SpaceTrackTLE[] = [];
  for (let i = 0; i < 5; i++) objs.push(mk(`2010-010${String.fromCharCode(65 + i)}`, "P SAT"));
  objs.push(mk("2011-011A", "Q SAT"), mk("2011-011B", "Q SAT"), mk("2011-011C", "Q SAT DEB"));
  objs.push(mk("2012-012A", "R DEB"), mk("2012-012B", "R DEB"), mk("2012-012C", "R DEB"));
  objs.push(mk("2013-013A", "S SAT"), mk("2013-013B", "S SAT"));
  objs.push(mk("", "TBA - TO BE ASSIGNED"), mk("UNKNOWN", "SOME DEB"));
  const full = F.groupFamilies(objs);
  assert.equal(full.totalObjects, 15);
  assert.equal(full.debrisObjects, 5);
  assert.deepEqual(full.families.map((f) => f.launchDesignator), ["2012-012", "2011-011", "2010-010", "2013-013"]);
  assert.equal(full.families[0].parentName, "R");
  const capped = F.groupFamilies(objs, 3);
  assert.deepEqual(capped.families.map((f) => f.launchDesignator), ["2012-012", "2011-011", "2010-010"]);
  assert.equal(capped.totalObjects, full.totalObjects);
  assert.equal(capped.debrisObjects, full.debrisObjects);
  assert.equal(F.groupFamilies(objs, 0).families.length, 0);
});

test("attribution covers collisions and repeat breakups (Iridium 33, two CZ-6A events)", () => {
  const r = F.groupFamilies([
    mk("1982-092ABC", "COSMOS 1408 DEB"),
    mk("1993-036AAA", "COSMOS 2251 DEB"),
    mk("1993-036AAB", "COSMOS 2251 DEB"),
    mk("1997-051AAA", "IRIDIUM 33 DEB"),
    mk("1997-051AAB", "IRIDIUM 33 DEB"),
    mk("1997-051AAC", "IRIDIUM 33"),
    mk("2022-151AAA", "CZ-6A DEB"),
    mk("2022-151AAB", "CZ-6A DEB"),
    mk("2024-140AAA", "CZ-6A DEB"),
    mk("2024-140AAB", "CZ-6A DEB"),
  ]);
  assert.deepEqual([r.catalogEventsPresent, r.debrisObjects, r.attributedDebrisObjects, r.families.length], [5, 9, 9, 4]);
  const ir = r.families.find((f) => f.launchDesignator === "1997-051");
  assert.ok(ir?.event);
  assert.deepEqual([ir.parentName, ir.count, ir.debrisCount], ["IRIDIUM 33", 3, 2]);
  assert.equal(r.families.find((f) => f.launchDesignator === "2022-151")?.event?.parentName, "CZ-6A R/B (YUNHAI 3)");
  assert.equal(r.families.find((f) => f.launchDesignator === "2024-140")?.event?.parentName, "CZ-6A R/B (QIANFAN)");
});

test("empty and malformed input is safe", () => {
  assert.deepEqual(F.groupFamilies([]), { totalObjects: 0, debrisObjects: 0, attributedDebrisObjects: 0, families: [], catalogEventsPresent: 0 });
  assert.equal(F.groupFamilies(null as unknown as SpaceTrackTLE[]).totalObjects, 0);
  assert.equal(F.groupFamilies([mk("2000-001A", "A"), mk("2000-001B", "A")], Number.NaN).families.length, 1);
});
