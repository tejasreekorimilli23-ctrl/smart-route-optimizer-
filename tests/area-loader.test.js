/*
 * Loading other towns: area boxes, search parsing, retries and building,
 * with fake servers (no internet needed). Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../js/area-loader.js");
const E = require("../js/route-engine.js");

const OSM_DIR = path.join(__dirname, "..", "data", "osm");

test("area boxes: a town's outline, or a square around a point", () => {
  const sq = A.square(18.3, 83.9, 4);
  const span = A.spanKm(sq);
  assert.ok(Math.abs(span.ns - 8) < 0.1 && Math.abs(span.ew - 8) < 0.1, JSON.stringify(span));
  // A huge outline (a district) is replaced by a square around the point.
  const district = { lat: 18.3, lon: 83.9, box: [17.8, 83.3, 18.9, 84.6] };
  assert.ok(A.spanKm(A.boxForResult(district)).ns < 9);
  // A town-sized outline is used as it is.
  const town = { lat: 18.3, lon: 83.9, box: [18.27, 83.87, 18.33, 83.93] };
  assert.deepEqual(A.boxForResult(town), town.box);
  // Two places 10 km apart fit in one area; 60 km apart do not.
  const both = A.boxAround({ lat: 18.10, lon: 83.40 }, { lat: 18.19, lon: 83.40 });
  assert.ok(both && A.contains(both, { lat: 18.10, lon: 83.40 }) && A.contains(both, { lat: 18.19, lon: 83.40 }));
  assert.equal(A.boxAround({ lat: 18.1, lon: 83.4 }, { lat: 18.65, lon: 83.4 }), null);
});

test("search results are read from OpenStreetMap's answer", () => {
  const rows = A.parseSearch([{ name: "Srikakulam", display_name: "Srikakulam, Andhra Pradesh, India", lat: "18.29", lon: "83.89", boundingbox: ["18.13", "18.45", "83.73", "84.05"] }]);
  assert.equal(rows[0].name, "Srikakulam");
  assert.deepEqual(rows[0].box, [18.13, 83.73, 18.45, 84.05], "south, west, north, east");
});

test("a busy server is retried, then the area is built and routable", async () => {
  if (!fs.existsSync(path.join(OSM_DIR, "roads.json"))) return;
  const roads = JSON.parse(fs.readFileSync(path.join(OSM_DIR, "roads.json"), "utf8"));
  const places = JSON.parse(fs.readFileSync(path.join(OSM_DIR, "places.json"), "utf8"));
  const saved = { ...A.SETTINGS };
  A.SETTINGS.attempts = [[0, 0], [0, 0.01], [1, 0]];
  let calls = 0;
  const steps = [];
  const fake = (url, opts) => {
    calls++;
    if (calls === 1) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) }); // busy
    const body = decodeURIComponent(opts.body);
    const json = body.includes("out body") ? roads : places;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
  };
  try {
    const box = [18.085, 83.375, 18.14, 83.445];
    const data = await A.load("Test town", box, (s) => steps.push(s), fake);
    assert.ok(steps.includes("retry"), "the user is told about the retry");
    // Roads and places download at the same time; "places" only shows if roads finish first.
    assert.deepEqual(steps.filter((s) => s !== "retry" && s !== "retrying" && s !== "places"), ["roads", "building", "validating"]);
    assert.ok(data.STATS.sectionsKept > 1000 && data.STATS.sectionsKept <= data.STATS.sectionsFound, "build statistics");
    assert.ok(data.STATS.placesOnRoads > 100 && data.STATS.placesOnRoads <= data.STATS.placesFound);
    assert.ok(data.NODES.length > 1000 && data.EDGES.length > 1000);
    assert.equal(data.AREA.name, "Test town");
    assert.ok(data.DEFAULTS.origin, "a starting place near the centre");
    const places2 = data.NODES.filter((n) => n.category);
    const r = E.findRoutes(data, E.levelsForHour(data, 9), places2[0].id, places2[places2.length - 1].id);
    assert.equal(r.ok, true);
  } finally {
    Object.assign(A.SETTINGS, saved);
  }
});

test("a download that never works ends with a clear error", async () => {
  const saved = { ...A.SETTINGS };
  A.SETTINGS.attempts = [[0, 0], [1, 0]];
  try {
    const busy = () => Promise.resolve({ ok: false, status: 504, json: () => Promise.resolve({}) });
    await assert.rejects(A.load("X", [18, 83, 18.05, 83.05], null, busy), (e) => e.code === "busy");
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    await assert.rejects(A.load("X", [18, 83, 18.05, 83.05], null, offline), (e) => e.code === "busy");
    const none = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ elements: [] }) });
    await assert.rejects(A.load("X", [18, 83, 18.05, 83.05], null, none), (e) => e.code === "noroads");
  } finally {
    Object.assign(A.SETTINGS, saved);
  }
});

test("a cancelled download stops at once and frees the server", async () => {
  const saved = { ...A.SETTINGS };
  let aborted = 0;
  const hanging = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); });
  });
  try {
    const ctl = new AbortController();
    const job = A.load("X", [18, 83, 18.05, 83.05], null, hanging, ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(job, (e) => e.code === "cancelled");
    assert.equal(aborted, 2, "both requests (roads and places) were stopped");
  } finally {
    Object.assign(A.SETTINGS, saved);
  }
});

test("'too many requests' (429) waits longer and is reported as a limit", async () => {
  const saved = { ...A.SETTINGS };
  A.SETTINGS.attempts = [[0, 0], [1, 0]];
  A.SETTINGS.limitPauseSeconds = 0.05;
  const steps = [];
  try {
    const limited = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
    const t0 = Date.now();
    await assert.rejects(A.load("X", [18, 83, 18.05, 83.05], (s, v) => steps.push(s + ":" + v), limited), (e) => e.code === "limit");
    assert.ok(Date.now() - t0 >= 45, "it waited before asking again");
    assert.ok(steps.includes("retry:0.05"), "the wait is shown");
    assert.ok(steps.some((s) => s.startsWith("retrying:2 / 2")), "the new attempt is shown");
  } finally {
    Object.assign(A.SETTINGS, saved);
  }
});
