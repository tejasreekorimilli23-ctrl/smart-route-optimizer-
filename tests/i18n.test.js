/*
 * Checks the English and Telugu interface text (js/i18n.js): every key used by
 * the page and the app exists, both languages have the same keys, and each
 * translation keeps the same {placeholders}. Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const I18N = require("../js/i18n.js");
const DEMO = require("../js/network-data.js");
const REAL = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(",");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

test("every text key used by the page and the app exists in English", () => {
  const used = new Set();
  const html = read("index.html");
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(";").forEach((p) => used.add(p.split(":")[1]));
  for (const f of ["js/app.js", "js/real-map-view.js"]) {
    for (const m of read(f).matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);
    for (const m of read(f).matchAll(/\btr\(\s*"([^"]+)"/g)) used.add(m[1]);
  }
  // Keys built from data.
  for (const k of DEMO.CONGESTION_ORDER) used.add("level." + k);
  for (const k of ["light", "moderate", "heavy"]) used.add("congestion." + k);
  for (const k of ["safer", "caution", "risk"]) used.add("rating." + k);
  for (const k of Object.keys(E.VEHICLES)) used.add("vehicle." + k).add("by." + k);
  for (const k of Object.keys(E.PRIORITIES)) used.add("cause.priority." + k);
  for (const k of ["nofetch", "nokey", "denied", "limit", "noanswer"]) used.add("live.err." + k);
  for (const m of ["real", "demo"]) ["note.planner.", "note.traffic.", "note.map."].forEach((p) => used.add(p + m));
  const missing = [...used].filter((k) => !k.endsWith(".") && I18N.en[k] === undefined && !/^(hazard|roadType|cat|band|bandDesc|scenario|scenarioDesc|te)\./.test(k));
  assert.deepEqual(missing, [], "missing English text");
});

test("Telugu has every English key, with the same placeholders", () => {
  const missing = Object.keys(I18N.en).filter((k) => I18N.te[k] === undefined);
  assert.deepEqual(missing, [], "missing Telugu text");
  for (const k of Object.keys(I18N.en)) {
    assert.equal(placeholders(I18N.te[k]), placeholders(I18N.en[k]), "placeholders differ for " + k);
  }
});

test("Telugu covers the labels that come from the map data", () => {
  const need = [];
  for (const d of [DEMO, REAL]) {
    Object.keys(d.HAZARDS).forEach((k) => need.push("hazard." + k));
    Object.keys(d.ROAD_TYPES).forEach((k) => need.push("roadType." + k));
    d.TIME_BANDS.forEach((b) => need.push("band." + slug(b.name)));
  }
  DEMO.TIME_BANDS.forEach((b) => need.push("bandDesc.demo." + slug(b.name)));
  REAL.TIME_BANDS.forEach((b) => need.push("bandDesc.real." + slug(b.name)));
  DEMO.SCENARIOS.forEach((s) => need.push("scenario." + s.id, "scenarioDesc." + s.id));
  REAL.PLACE_CATEGORIES.forEach((c) => need.push("cat." + slug(c)));
  const missing = [...new Set(need)].filter((k) => I18N.te[k] === undefined);
  assert.deepEqual(missing, []);
});
