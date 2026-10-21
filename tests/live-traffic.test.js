/*
 * Live traffic (TomTom) tests, with a fake TomTom server: no key or internet
 * needed. Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");
const LT = require("../js/live-traffic.js");

const KEY = "TEST_KEY_1234567890";

/** A fake fetch: answers each point with the shape of the road section it was sampled from. */
function fakeTomTom(speedFor, status) {
  const calls = [];
  const points = LT.samplePoints(R);
  const fetchImpl = (url) => {
    calls.push(url);
    if (status) return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
    const m = /point=([\d.]+),([\d.]+)/.exec(url);
    const p = points.find((q) => q.lat.toFixed(5) === m[1] && q.lon.toFixed(5) === m[2]);
    const e = R.EDGES.find((x) => x.id === p.edgeId);
    const coordinate = [];
    for (let i = 0; i < e.geom.length; i += 2) coordinate.push({ latitude: e.geom[i], longitude: e.geom[i + 1] });
    const speeds = speedFor(e);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ flowSegmentData: { ...speeds, coordinates: { coordinate } } })
    });
  };
  return { fetchImpl, calls, points };
}

test("sample points cover the main roads without wasting requests", () => {
  const pts = LT.samplePoints(R);
  assert.ok(pts.length > 20 && pts.length <= LT.SETTINGS.maxPoints, pts.length + " points");
  assert.ok(new Set(pts.map((p) => p.road)).size > 15, "should cover many different roads");
  // Deterministic, so the daily request count is predictable.
  assert.deepEqual(LT.samplePoints(R), pts);
});

test("speed ratio becomes a traffic level", () => {
  assert.equal(LT.levelFor({ currentSpeed: 40, freeFlowSpeed: 40 }), "light");
  assert.equal(LT.levelFor({ currentSpeed: 32, freeFlowSpeed: 40 }), "light");
  assert.equal(LT.levelFor({ currentSpeed: 31, freeFlowSpeed: 40 }), "moderate");
  assert.equal(LT.levelFor({ currentSpeed: 20, freeFlowSpeed: 40 }), "moderate");
  assert.equal(LT.levelFor({ currentSpeed: 19, freeFlowSpeed: 40 }), "heavy");
  assert.equal(LT.levelFor({ currentSpeed: 30, freeFlowSpeed: 40, roadClosure: true }), "closed");
  assert.equal(LT.levelFor({ currentSpeed: 30, freeFlowSpeed: 0 }), null);
});

test("live readings are matched to main-road sections and change the route", async () => {
  // Every main road is crawling at a quarter of its free-flow speed.
  const { fetchImpl, calls, points } = fakeTomTom(() => ({ currentSpeed: 10, freeFlowSpeed: 40 }));
  const live = await LT.fetchLive(R, KEY, fetchImpl);
  assert.equal(calls.length, points.length, "one request per sample point");
  assert.ok(calls.every((u) => u.includes("key=" + KEY) && u.startsWith("https://api.tomtom.com/")));
  assert.equal(live.answered, points.length);
  assert.ok(live.roads >= points.length, "each reading covers at least its own section");
  for (const [id, level] of Object.entries(live.levels)) {
    assert.equal(level, "heavy");
    assert.ok(/^(trunk|primary|secondary|tertiary|motorway)/.test(R.EDGES.find((e) => e.id === id).type), "only main roads");
  }
  const levels = { ...E.levelsForHour(R, 6), ...live.levels };
  const calm = E.findRoutes(R, E.levelsForHour(R, 6), R.DEFAULTS.origin, R.DEFAULTS.destination);
  const jammed = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination);
  assert.ok(jammed.recommended.timeUnits >= calm.recommended.timeUnits, "jams cannot make the trip faster");
});

test("TomTom errors are reported with a code the app can translate", async () => {
  await assert.rejects(LT.fetchLive(R, "", () => null), (e) => e.code === "nokey");
  await assert.rejects(LT.fetchLive(R, KEY, fakeTomTom(null, 403).fetchImpl), (e) => e.code === "denied");
  await assert.rejects(LT.fetchLive(R, KEY, fakeTomTom(null, 429).fetchImpl), (e) => e.code === "limit");
  await assert.rejects(LT.fetchLive(R, KEY, fakeTomTom(null, 500).fetchImpl), (e) => e.code === "noanswer");
  // A refused key stops early instead of using up the daily allowance.
  const denied = fakeTomTom(null, 403);
  await assert.rejects(LT.fetchLive(R, KEY, denied.fetchImpl));
  assert.ok(denied.calls.length <= LT.SETTINGS.parallel, denied.calls.length + " requests after a refusal");
});

test("a fetch that throws straight away is treated as no answer, not a crash", async () => {
  const throwing = () => { throw new TypeError("blocked"); };
  await assert.rejects(LT.fetchLive(R, KEY, throwing), (e) => e.code === "noanswer");
});

test("without a fetch argument it uses the browser's global fetch", async () => {
  const saved = global.fetch;
  let calls = 0;
  global.fetch = () => { calls++; return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }); };
  try {
    await assert.rejects(LT.fetchLive(R, KEY), (e) => e.code === "denied");
    assert.ok(calls > 0, "global fetch was not used");
  } finally {
    global.fetch = saved;
  }
});

// ---------- incidents ----------

/** A TomTom-style incident lying along one of our road sections. */
function incidentOn(edge, iconCategory, magnitudeOfDelay, extra) {
  const coordinates = [];
  for (let i = 0; i < edge.geom.length; i += 2) coordinates.push([edge.geom[i + 1], edge.geom[i]]); // [lon, lat]
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates },
    properties: { id: "t-" + edge.id, iconCategory, magnitudeOfDelay, events: [{ description: "Test incident" }], from: "A", to: "B", delay: 300, ...extra }
  };
}

const recommendedEdge = () => {
  const r = E.findRoutes(R, E.levelsForHour(R, 12), R.DEFAULTS.origin, R.DEFAULTS.destination);
  const named = r.recommended.edges.map((id) => R.EDGES.find((e) => e.id === id)).filter((e) => e.type !== "access");
  return named[Math.floor(named.length / 2)];
};

test("incident categories and delays become traffic levels", () => {
  assert.equal(LT.incidentLevel("closed", 0), "closed");
  assert.equal(LT.incidentLevel("accident", 4), "closed");
  assert.equal(LT.incidentLevel("accident", 3), "heavy");
  assert.equal(LT.incidentLevel("roadworks", 2), "heavy");
  assert.equal(LT.incidentLevel("jam", 1), "moderate");
  assert.equal(LT.incidentLevel("accident", 0), "moderate", "an accident always slows the road");
  assert.equal(LT.incidentLevel("fog", 0), null, "weather with no delay changes nothing");
  assert.ok(R.HAZARDS.incident, "the map data has the live incident hazard");
});

test("an incident is placed on the right road sections", () => {
  const e = recommendedEdge();
  const out = LT.incidentsFromResponse(R, { incidents: [incidentOn(e, 1, 2)] });
  assert.equal(out.incidents.length, 1);
  assert.equal(out.incidents[0].category, "accident");
  assert.ok(out.incidents[0].edges.includes(e.id), "the incident's own road is matched");
  assert.equal(out.levels[e.id], "heavy");
  assert.ok(out.unsafe.includes(e.id), "an accident makes the road unsafe");
  assert.equal(out.byEdge[e.id].id, "t-" + e.id);
  // It should not spread to roads far away.
  for (const id of out.incidents[0].edges) {
    const other = R.EDGES.find((x) => x.id === id);
    assert.ok(Math.abs(other.geom[0] - e.geom[0]) < 0.01 && Math.abs(other.geom[1] - e.geom[1]) < 0.01, id + " is far from the incident");
  }
  // A point incident goes to the nearest section only.
  const pt = { type: "Feature", geometry: { type: "Point", coordinates: [e.geom[1], e.geom[0]] }, properties: { iconCategory: 14, magnitudeOfDelay: 1 } };
  const one = LT.incidentsFromResponse(R, { incidents: [pt] });
  assert.equal(one.incidents[0].edges.length, 1);
  // Jams slow the road but do not make it unsafe.
  const jam = LT.incidentsFromResponse(R, { incidents: [incidentOn(e, 6, 1)] });
  assert.equal(jam.levels[e.id], "moderate");
  assert.deepEqual(jam.unsafe, []);
});

test("a road closure or accident on today's route changes the recommendation", () => {
  const e = recommendedEdge();
  const levels = E.levelsForHour(R, 12);
  const before = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination);
  assert.ok(before.recommended.edges.includes(e.id));

  // Closure: the road is removed, so no route may use it.
  const closed = LT.incidentsFromResponse(R, { incidents: [incidentOn(e, 8, 4)] });
  const after = E.findRoutes(R, { ...levels, ...closed.levels }, R.DEFAULTS.origin, R.DEFAULTS.destination);
  assert.equal(after.ok, true);
  for (const r of after.routes) for (const id of closed.incidents[0].edges) assert.ok(!r.edges.includes(id), "route uses the closed road");

  // Accident: the road gets the live incident hazard, so the safest route avoids it when it can.
  const acc = LT.incidentsFromResponse(R, { incidents: [incidentOn(e, 1, 1)] });
  const marked = new Set(acc.unsafe);
  const data = { ...R, EDGES: R.EDGES.map((x) => (marked.has(x.id) ? { ...x, hazards: ["incident", ...x.hazards] } : x)) };
  const safe = E.findRoutes(data, { ...levels, ...acc.levels }, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority: "safest" });
  assert.ok(!safe.recommended.edges.some((id) => marked.has(id)), "the safest route still goes past the accident");
});

test("incidents are fetched with one request for the whole area", async () => {
  const urls = [];
  const fake = (url) => {
    urls.push(url);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ incidents: [incidentOn(recommendedEdge(), 9, 1)] }) });
  };
  const out = await LT.fetchIncidents(R, KEY, fake);
  assert.equal(urls.length, 1);
  const [s, w, n, e] = R.AREA.bbox;
  assert.ok(urls[0].startsWith("https://api.tomtom.com/traffic/services/5/incidentDetails?bbox=" + [w, s, e, n].join(",")));
  assert.ok(urls[0].includes("key=" + KEY) && urls[0].includes("timeValidityFilter=present"));
  assert.equal(out.incidents[0].category, "roadworks");
  assert.ok(out.fetchedAt instanceof Date);
  const status = (code) => () => Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({}) });
  await assert.rejects(LT.fetchIncidents(R, KEY, status(403)), (err) => err.code === "denied");
  await assert.rejects(LT.fetchIncidents(R, KEY, status(429)), (err) => err.code === "limit");
  await assert.rejects(LT.fetchIncidents(R, KEY, status(500)), (err) => err.code === "noanswer");
  await assert.rejects(LT.fetchIncidents(R, "", fake), (err) => err.code === "nokey");
});
