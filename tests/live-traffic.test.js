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
