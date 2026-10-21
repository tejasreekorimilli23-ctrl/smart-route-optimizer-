/*
 * Route objectives (fastest, shortest, safest), GPS accuracy safeguards and
 * time-outs for the online services. Run with: npm test
 *
 * The TomTom and Firebase tests here use fake servers that never answer:
 * they prove the app gives up cleanly, not that the real services work.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/network-data.js");
const R = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");
const Trip = require("../js/trip.js");
const LT = require("../js/live-traffic.js");
const CM = require("../js/community.js");

/** Brute force over the demo town: every simple path with its totals. */
function allSimplePaths(levels, from, to) {
  const graph = E.buildGraph(D, levels);
  const out = [];
  (function dfs(node, seen, time, dist, risk, fuel) {
    if (node === to) {
      out.push({ timeUnits: time, distanceUnits: dist, riskUnits: risk, fuelUnits: fuel });
      return;
    }
    for (const { to: next, edgeId } of graph.adj[node]) {
      if (seen.has(next)) continue;
      const info = graph.edgeInfo[edgeId];
      seen.add(next);
      dfs(next, seen, time + info.timeUnits, dist + info.distanceUnits, risk + info.riskUnits, fuel + info.fuelUnits);
      seen.delete(next);
    }
  })(from, new Set([from]), 0, 0, 0, 0);
  return out;
}

const OBJECTIVES = { fastest: ["timeUnits", "isFastest"], shortest: ["distanceUnits", "isShortest"], safest: ["riskUnits", "isSafest"], greenest: ["fuelUnits", "isGreenest"] };

test("every pair, every condition, all four objectives: each is truly optimal and every objective's best is shown", () => {
  let checked = 0;
  const conditions = D.SCENARIOS.map((s) => E.levelsForScenario(D, s.id));
  for (let h = D.DAY_START_HOUR; h <= D.DAY_END_HOUR; h += 3) conditions.push(E.levelsForHour(D, h));
  for (const levels of conditions) {
    for (const o of D.NODES) {
      for (const d of D.NODES) {
        if (o.id === d.id) continue;
        const brute = allSimplePaths(levels, o.id, d.id);
        for (const priority of Object.keys(OBJECTIVES)) {
          const res = E.findRoutes(D, levels, o.id, d.id, { priority });
          const where = `${priority} ${o.id}->${d.id}`;
          if (!brute.length) {
            assert.equal(res.code, "UNREACHABLE", where);
            continue;
          }
          checked++;
          const [key] = OBJECTIVES[priority];
          assert.equal(res.recommended[key], Math.min(...brute.map((p) => p[key])), where + " not optimal");
          for (const [k, flag] of Object.values(OBJECTIVES)) {
            const marked = res.routes.filter((r) => r[flag]);
            assert.equal(marked.length, 1, where + " " + flag + " not marked exactly once");
            assert.equal(marked[0][k], Math.min(...brute.map((p) => p[k])), where + " " + flag + " is not the best");
          }
          const sigs = res.routes.map((r) => r.signature);
          assert.equal(new Set(sigs).size, sigs.length, where + " duplicate alternatives");
          assert.ok(res.routes.length <= Math.max(E.SETTINGS.maxRoutes, Object.keys(E.PRIORITIES).length), where + " too many routes");
        }
      }
    }
  }
  assert.ok(checked > 1000, "checked " + checked);
});

test("real map, Thotapalem to Vizianagaram Junction: the three objectives keep their own meaning", () => {
  const levels = E.levelsForHour(R, 9); // morning rush estimate
  const run = (priority) => E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority });
  const fastest = run("fastest");
  const shortest = run("shortest");
  const safest = run("safest");
  for (const res of [fastest, shortest, safest]) assert.equal(res.ok, true);
  assert.ok(shortest.recommended.distanceUnits <= fastest.recommended.distanceUnits, "shortest is not longer than fastest");
  assert.ok(shortest.recommended.distanceUnits <= safest.recommended.distanceUnits, "shortest is not longer than safest");
  assert.ok(fastest.recommended.timeUnits <= shortest.recommended.timeUnits, "fastest is not slower than shortest");
  assert.ok(fastest.recommended.timeUnits <= safest.recommended.timeUnits, "fastest is not slower than safest");
  assert.ok(safest.recommended.riskUnits <= fastest.recommended.riskUnits, "safest has no more risk than fastest");
  assert.ok(safest.recommended.riskUnits <= shortest.recommended.riskUnits, "safest has no more risk than shortest");
  const greenest = run("greenest");
  assert.equal(greenest.ok, true);
  for (const other of [fastest, shortest, safest]) {
    assert.ok(greenest.recommended.fuelUnits <= other.recommended.fuelUnits, "greenest uses no more fuel than " + other.priority);
  }
  assert.ok(greenest.recommended.fuelUnits > 0);
});

test("unknown priority still falls back to fastest; shortest is accepted", () => {
  const o = D.DEFAULTS.origin;
  const d = D.DEFAULTS.destination;
  const levels = E.levelsForHour(D, 12);
  assert.equal(E.findRoutes(D, levels, o, d, { priority: "nonsense" }).priority, "fastest");
  assert.equal(E.findRoutes(D, levels, o, d, { priority: "shortest" }).priority, "shortest");
});

// ---------- GPS accuracy ----------

function setupLine() {
  const edgeById = Object.fromEntries(R.EDGES.map((e) => [e.id, e]));
  const route = E.findRoutes(R, E.levelsForHour(R, 12), R.DEFAULTS.origin, R.DEFAULTS.destination).recommended;
  const ln = Trip.line(route, edgeById);
  const p = ln.pts[Math.floor(ln.pts.length / 2)];
  return { ln, p };
}

test("vague GPS positions never trigger re-routing", () => {
  const { ln, p } = setupLine();
  const off = Trip.offRouteCounter();
  const far = Trip.locate(ln, { lat: p.lat + 0.002, lon: p.lon + 0.002 }); // ~300 m away
  for (let i = 0; i < 5; i++) assert.equal(off(far, 500), false, "a ±500 m fix is ignored");
});

test("the off-route tolerance is never smaller than the GPS accuracy", () => {
  const { ln, p } = setupLine();
  const off = Trip.offRouteCounter();
  // About 70 m away: beyond the 50 m tolerance, but within a ±80 m fix.
  const near = Trip.locate(ln, { lat: p.lat + 0.00045, lon: p.lon + 0.00045 });
  assert.ok(near.offset > Trip.SETTINGS.offRouteMetres && near.offset < 80, "offset " + near.offset);
  assert.equal(off(near, 80), false);
  assert.equal(off(near, 80), false, "still within the accuracy");
  // The same position with a precise fix does count.
  assert.equal(off(near, 5), false);
  assert.equal(off(near, 5), true);
});

// ---------- time-outs (fake servers that never answer) ----------

const never = () => new Promise(() => {});
const KEY = "TESTKEY1234567890";

test("TomTom: no answer within the time limit gives a 'timeout' error, not endless loading", async () => {
  const saved = LT.SETTINGS.timeoutMs;
  LT.SETTINGS.timeoutMs = 30;
  try {
    await assert.rejects(LT.fetchIncidents(R, KEY, never), (e) => e.code === "timeout");
    await assert.rejects(LT.fetchLive(R, KEY, never), (e) => e.code === "timeout");
  } finally {
    LT.SETTINGS.timeoutMs = saved;
  }
});

test("TomTom: a reply that is not JSON is reported as no answer", async () => {
  const bad = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("not json")) });
  await assert.rejects(LT.fetchIncidents(R, KEY, bad), (e) => e.code === "noanswer");
  await assert.rejects(LT.fetchLive(R, KEY, bad), (e) => e.code === "noanswer");
});

test("Firebase: no answer within the time limit gives a 'timeout' error", async () => {
  const saved = CM.SETTINGS.timeoutMs;
  CM.SETTINGS.timeoutMs = 30;
  try {
    const store = CM.firebaseStore({ apiKey: "k", projectId: "p" }, never);
    await assert.rejects(store.listReports(new Date()), (e) => e.code === "timeout");
  } finally {
    CM.SETTINGS.timeoutMs = saved;
  }
});

test("greenest: the fuel weight follows the same documented model as the dashboard", () => {
  const TA = require("../js/analytics.js");
  for (const v of ["car", "auto", "twowheeler"]) {
    assert.equal(E.VEHICLES[v].kmPerLitre, TA.ECO[v].kmPerLitre, v);
    assert.equal(E.VEHICLES[v].idleLitresPerHour, TA.ECO[v].idleLitresPerHour, v);
  }
  const levels = E.levelsForHour(R, 9);
  const r = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority: "greenest", vehicle: "car" }).recommended;
  const perMin = E.unitsOf(R).perMin;
  const model = TA.eco(r.distanceUnits / 1000, r.delayUnits / perMin / 60, "car").litres;
  assert.ok(Math.abs(E.fuelLitres(r.fuelUnits) - model) < 0.01, E.fuelLitres(r.fuelUnits) + " vs " + model);
  // Walking uses no fuel: the greenest walk is the quickest walk.
  const walkGreen = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority: "greenest", vehicle: "walk" }).recommended;
  const walkFast = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority: "fastest", vehicle: "walk" }).recommended;
  assert.equal(walkGreen.fuelUnits, 0);
  assert.equal(walkGreen.timeUnits, walkFast.timeUnits);
});

test("greenest long routes: candidates ranked by estimated fuel", () => {
  const LR = require("../js/long-route.js");
  const routes = [
    { durationS: 2400, distanceM: 42000, riskUnits: 1, fuelUnits: 3000000 },
    { durationS: 2600, distanceM: 39000, riskUnits: 2, fuelUnits: 2600000 }
  ];
  assert.equal(LR.rank(routes, "greenest")[0], routes[1]);
  assert.ok(routes[1].isGreenest && !routes[0].isGreenest);
  const real = LR.fromOsrm(require("./fixtures/osrm-vizag-lendi.json"), "car")[0];
  assert.equal(real.fuelUnits, Math.round(1e6 * (real.distanceM / 1000 / 15)), "no traffic data: distance / mileage");
});
