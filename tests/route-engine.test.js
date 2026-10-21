/*
 * Route engine tests. Run with:  npm test   (uses Node's built-in test runner,
 * no dependencies needed).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/network-data.js");
const E = require("../js/route-engine.js");

const levelsFor = (id) => E.levelsForScenario(D, id);

/** Brute force: every simple path between two nodes, with its totals. */
function allSimplePaths(levels, from, to) {
  const graph = E.buildGraph(D, levels);
  const out = [];
  (function dfs(node, seen, edges, time, dist, risk) {
    if (node === to) {
      out.push({ edges: edges.slice(), timeUnits: time, distanceUnits: dist, riskUnits: risk });
      return;
    }
    for (const { to: next, edgeId } of graph.adj[node]) {
      if (seen.has(next)) continue;
      const info = graph.edgeInfo[edgeId];
      seen.add(next);
      edges.push(edgeId);
      dfs(next, seen, edges, time + info.timeUnits, dist + info.distanceUnits, risk + info.riskUnits);
      edges.pop();
      seen.delete(next);
    }
  })(from, new Set([from]), [], 0, 0, 0);
  return out;
}

/** Every traffic condition the UI can produce from presets: scenarios and hours. */
function allConditions() {
  const out = D.SCENARIOS.map((s) => ({ id: s.id, levels: levelsFor(s.id) }));
  for (let h = D.DAY_START_HOUR; h <= D.DAY_END_HOUR; h++) out.push({ id: "hour" + h, levels: E.levelsForHour(D, h) });
  return out;
}

function edgeBetween(a, b) {
  return D.EDGES.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
}

test("network data is internally consistent", () => {
  const nodeIds = new Set(D.NODES.map((n) => n.id));
  assert.equal(nodeIds.size, D.NODES.length, "duplicate location id");
  const edgeIds = new Set();
  const pairs = new Set();
  for (const e of D.EDGES) {
    assert.ok(!edgeIds.has(e.id), "duplicate road id " + e.id);
    edgeIds.add(e.id);
    assert.ok(nodeIds.has(e.from) && nodeIds.has(e.to), "road " + e.id + " has unknown ends");
    assert.notEqual(e.from, e.to, "road " + e.id + " is a loop");
    const key = [e.from, e.to].sort().join("-");
    assert.ok(!pairs.has(key), "two roads join the same pair: " + key);
    pairs.add(key);
    assert.ok(e.distanceKm > 0, "distance must be positive");
    assert.ok(D.ROAD_TYPES[e.type], "unknown road type on " + e.id);
  }
  for (const s of D.SCENARIOS) {
    for (const [eid, lv] of Object.entries(s.levels)) {
      assert.ok(edgeIds.has(eid), s.id + " refers to unknown road " + eid);
      assert.ok(D.CONGESTION_LEVELS[lv], s.id + " uses unknown level " + lv);
    }
  }
  for (const e of D.EDGES) {
    assert.ok(Array.isArray(e.hazards), "road " + e.id + " needs a hazards list");
    for (const h of e.hazards) assert.ok(D.HAZARDS[h], "road " + e.id + " has unknown hazard " + h);
    assert.equal(new Set(e.hazards).size, e.hazards.length, "road " + e.id + " repeats a hazard");
  }
  assert.ok(D.NODES.some((n) => n.kind === "hospital"), "need at least one hospital");
  // Time bands cover every hour of the day exactly once, with valid levels.
  for (let h = D.DAY_START_HOUR; h <= D.DAY_END_HOUR; h++) {
    const bands = D.TIME_BANDS.filter((b) => h >= b.from && h <= b.to);
    assert.equal(bands.length, 1, "hour " + h + " is covered by " + bands.length + " bands");
  }
  for (const b of D.TIME_BANDS) {
    if (b.scenario) assert.ok(D.SCENARIOS.some((s) => s.id === b.scenario), b.name + " refers to unknown scenario");
    for (const [eid, lv] of Object.entries(b.levels || {})) {
      assert.ok(edgeIds.has(eid), b.name + " refers to unknown road " + eid);
      assert.ok(D.CONGESTION_LEVELS[lv], b.name + " uses unknown level " + lv);
    }
  }
});

test("safest route avoids the MG Road black spot; fastest and safest are both shown", () => {
  const fast = E.findRoutes(D, levelsFor("offpeak"), "BUS", "COL");
  assert.equal(fast.priority, "fastest");
  assert.deepEqual(fast.recommended.nodes, ["BUS", "CLK", "TWN", "COL"]);
  assert.equal(fast.recommended.riskUnits, 151); // 2.6 km x 4 + 2.2 x 1 + 2.5 x 1
  assert.equal(fast.recommended.safety.key, "risk");
  assert.ok(fast.recommended.hazards.some((h) => h.id === "blackspot" && h.roadName === "MG Road (west)"));
  const safeInFast = fast.routes.find((r) => r.isSafest);
  assert.deepEqual(safeInFast.nodes, ["BUS", "RNG", "IND", "STD", "COL"]);

  const safe = E.findRoutes(D, levelsFor("offpeak"), "BUS", "COL", { priority: "safest" });
  assert.equal(safe.priority, "safest");
  assert.deepEqual(safe.recommended.nodes, ["BUS", "RNG", "IND", "STD", "COL"]);
  assert.equal(safe.recommended.riskUnits, 106);
  assert.equal(safe.recommended.safety.key, "safer");
  assert.deepEqual(safe.recommended.hazards, []);
  const fastInSafe = safe.routes.find((r) => r.isFastest);
  assert.deepEqual(fastInSafe.nodes, ["BUS", "CLK", "TWN", "COL"]);
  assert.equal(fastInSafe.extraTimeUnits, -12); // fastest saves 1.2 min
  assert.equal(fastInSafe.extraRiskUnits, 45);
});

test("unknown priority falls back to fastest", () => {
  const r = E.findRoutes(D, levelsFor("offpeak"), "BUS", "COL", { priority: "scenic" });
  assert.equal(r.priority, "fastest");
  assert.deepEqual(r.recommended.nodes, ["BUS", "CLK", "TWN", "COL"]);
});

test("safety rating thresholds", () => {
  assert.equal(E.classifySafety(1).key, "safer");
  assert.equal(E.classifySafety(1.3).key, "safer");
  assert.equal(E.classifySafety(1.31).key, "caution");
  assert.equal(E.classifySafety(2).key, "caution");
  assert.equal(E.classifySafety(2.01).key, "risk");
});

test("emergency finds the fastest route to a hospital and handles edge cases", () => {
  const lv = levelsFor("offpeak");
  const r = E.findEmergencyRoute(D, lv, "BUS");
  assert.equal(r.ok, true);
  assert.equal(r.emergency, true);
  assert.equal(r.hospital.id, "HSP");
  assert.equal(r.priority, "fastest");
  const direct = E.findRoutes(D, lv, "BUS", "HSP");
  assert.equal(r.recommended.timeUnits, direct.recommended.timeUnits);

  assert.equal(E.findEmergencyRoute(D, lv, "").code, "MISSING_ORIGIN");
  assert.equal(E.findEmergencyRoute(D, lv, "NOPE").code, "INVALID_LOCATION");
  assert.equal(E.findEmergencyRoute(D, lv, "HSP").code, "AT_HOSPITAL");
  const cut = E.findEmergencyRoute(D, levelsFor("roadworks"), "LKV");
  assert.equal(cut.code, "UNREACHABLE");
  assert.ok(cut.closedRoads.includes("Lake Bridge"));

  // With two hospitals, the one with the shorter journey time wins.
  const two = { ...D, NODES: D.NODES.map((n) => (n.id === "COL" ? { ...n, kind: "hospital" } : n)) };
  const fromStd = E.findEmergencyRoute(two, lv, "STD");
  assert.equal(fromStd.hospital.id, "COL");
  const toHsp = E.findRoutes(two, lv, "STD", "HSP");
  assert.ok(fromStd.recommended.timeUnits <= toHsp.recommended.timeUnits);
});

test("time of day maps hours to traffic bands", () => {
  assert.equal(E.bandForHour(D, 9).name, "Morning rush");
  assert.deepEqual(E.levelsForHour(D, 9), levelsFor("rush"));
  assert.deepEqual(E.levelsForHour(D, 12), levelsFor("offpeak"));
  assert.equal(E.bandForHour(D, 18).name, "Evening rush");
  assert.equal(E.levelsForHour(D, 18).e15, "heavy");
  assert.equal(E.levelsForHour(D, 6).e05, "light");
  assert.equal(E.levelsForHour(D, 5), null);
  assert.equal(E.levelsForHour(D, 23), null);
  assert.equal(E.levelsForHour(D, 9.5), null);
  assert.equal(E.levelsForHour(D, "9"), null);
  // The evening rush jams MG Road (west), so the fastest route moves to Ring Road.
  const r = E.findRoutes(D, E.levelsForHour(D, 18), "BUS", "COL");
  assert.deepEqual(r.recommended.nodes, ["BUS", "RNG", "IND", "STD", "COL"]);
});

test("off-peak: Bus Station to Engineering College recommends the MG Road route", () => {
  const r = E.findRoutes(D, levelsFor("offpeak"), "BUS", "COL");
  assert.equal(r.ok, true);
  assert.deepEqual(r.recommended.nodes, ["BUS", "CLK", "TWN", "COL"]);
  assert.equal(r.recommended.timeUnits, 133);
  assert.equal(r.recommended.distanceUnits, 73);
  assert.ok(r.routes.length >= 2, "should offer alternatives");
});

test("morning rush changes the recommendation to the Ring Road route", () => {
  const before = E.findRoutes(D, levelsFor("offpeak"), "BUS", "COL");
  const after = E.findRoutes(D, levelsFor("rush"), "BUS", "COL");
  assert.notEqual(before.recommended.signature, after.recommended.signature);
  assert.deepEqual(after.recommended.nodes, ["BUS", "RNG", "IND", "STD", "COL"]);
  // The old route re-timed under rush traffic must be slower than the new pick.
  const old = E.evaluatePath(D, levelsFor("rush"), before.recommended.edges);
  assert.equal(old.closed, false);
  assert.equal(old.timeUnits, 288);
  assert.ok(old.timeUnits > after.recommended.timeUnits);
});

test("a single road change can flip the recommendation", () => {
  const levels = levelsFor("offpeak");
  levels.e08 = "moderate"; // MG Road (east)
  const r = E.findRoutes(D, levels, "BUS", "COL");
  assert.deepEqual(r.recommended.nodes, ["BUS", "RNG", "IND", "STD", "COL"]);
});

test("invalid selections are rejected with clear codes", () => {
  const lv = levelsFor("offpeak");
  assert.equal(E.findRoutes(D, lv, "", "COL").code, "MISSING_ORIGIN");
  assert.equal(E.findRoutes(D, lv, "BUS", "").code, "MISSING_DESTINATION");
  assert.equal(E.findRoutes(D, lv, undefined, null).code, "MISSING_ORIGIN");
  assert.equal(E.findRoutes(D, lv, "NOPE", "COL").code, "INVALID_LOCATION");
  assert.equal(E.findRoutes(D, lv, "BUS", "NOPE").code, "INVALID_LOCATION");
  const same = E.findRoutes(D, lv, "BUS", "BUS");
  assert.equal(same.code, "SAME_LOCATION");
  assert.equal(same.ok, false);
  assert.deepEqual(same.routes, []);
});

test("closing the only road makes a destination unreachable, and reopening restores it", () => {
  const closed = E.findRoutes(D, levelsFor("roadworks"), "BUS", "LKV");
  assert.equal(closed.ok, false);
  assert.equal(closed.code, "UNREACHABLE");
  assert.ok(closed.closedRoads.includes("Lake Bridge"));
  const lv = levelsFor("roadworks");
  lv.e19 = "light";
  assert.equal(E.findRoutes(D, lv, "BUS", "LKV").ok, true);
});

test("unknown traffic levels fall back to light instead of crashing", () => {
  const lv = levelsFor("offpeak");
  lv.e05 = "gridlock";
  delete lv.e08;
  const norm = E.normalizeLevels(D, lv);
  assert.equal(norm.e05, "light");
  assert.equal(norm.e08, "light");
  assert.equal(E.findRoutes(D, lv, "BUS", "COL").ok, true);
  assert.equal(E.findRoutes(D, null, "BUS", "COL").ok, true);
});

test("results are deterministic", () => {
  const a = E.findRoutes(D, levelsFor("market"), "RLY", "LKV");
  const b = E.findRoutes(D, levelsFor("market"), "RLY", "LKV");
  assert.deepEqual(a, b);
});

test("every pair, every condition, both priorities: valid, distinct, consistent and truly best", () => {
  let pairsChecked = 0;
  let pairsWithAlternatives = 0;
  for (const sc of allConditions()) {
    const levels = sc.levels;
    for (const o of D.NODES) {
      for (const d of D.NODES) {
        if (o.id === d.id) continue;
        const brute = allSimplePaths(levels, o.id, d.id);
        for (const priority of ["fastest", "safest"]) {
          const res = E.findRoutes(D, levels, o.id, d.id, { priority });
          const where = `${sc.id} ${priority} ${o.id}->${d.id}`;

          if (!brute.length) {
            assert.equal(res.code, "UNREACHABLE", where);
            continue;
          }
          assert.equal(res.ok, true, where);
          pairsChecked++;

          // Optimal: recommendation equals the brute-force minimum for the
          // priority, and the best route for the other priority is also shown.
          const minTime = Math.min(...brute.map((p) => p.timeUnits));
          const minRisk = Math.min(...brute.map((p) => p.riskUnits));
          const key = priority === "safest" ? "riskUnits" : "timeUnits";
          assert.equal(res.recommended[key], priority === "safest" ? minRisk : minTime, where + " not optimal");
          const fastest = res.routes.filter((r) => r.isFastest);
          const safest = res.routes.filter((r) => r.isSafest);
          assert.equal(fastest.length, 1, where + " fastest route not marked once");
          assert.equal(safest.length, 1, where + " safest route not marked once");
          assert.equal(fastest[0].timeUnits, minTime, where + " fastest badge on a slower route");
          assert.equal(safest[0].riskUnits, minRisk, where + " safest badge on a riskier route");

          // At least two routes whenever the network has two.
          if (brute.length >= 2) {
            assert.ok(res.routes.length >= 2, where + " missing alternative");
            pairsWithAlternatives++;
          }
          assert.ok(res.routes.length <= E.SETTINGS.maxRoutes, where);

          const sigs = new Set();
          res.routes.forEach((r, i) => {
            // No duplicates.
            assert.ok(!sigs.has(r.signature), where + " duplicate route");
            sigs.add(r.signature);
            // Valid path: right ends, consecutive roads exist, open, no repeated stop.
            assert.equal(r.nodes[0], o.id, where);
            assert.equal(r.nodes[r.nodes.length - 1], d.id, where);
            assert.equal(new Set(r.nodes).size, r.nodes.length, where + " repeats a stop");
            assert.equal(r.edges.length, r.nodes.length - 1, where);
            r.edges.forEach((eid, k) => {
              const e = edgeBetween(r.nodes[k], r.nodes[k + 1]);
              assert.ok(e && e.id === eid, where + " broken path");
              assert.notEqual(levels[eid], "closed", where + " uses a closed road");
            });
            // Displayed numbers add up exactly.
            const sum = (f) => r.segments.reduce((s, x) => s + x[f], 0);
            assert.equal(r.timeUnits, sum("timeUnits"), where + " time total");
            assert.equal(r.distanceUnits, sum("distanceUnits"), where + " distance total");
            assert.equal(r.freeFlowUnits, sum("freeFlowUnits"), where + " free-flow total");
            assert.equal(r.riskUnits, sum("riskUnits"), where + " risk total");
            assert.equal(r.delayUnits, r.timeUnits - r.freeFlowUnits, where);
            r.segments.forEach((s) => {
              assert.equal(s.timeUnits, Math.round(s.freeFlowUnits * s.factor + 1e-9), where + " row maths");
              const weight = D.BASE_RISK + s.hazards.reduce((t, h) => t + D.HAZARDS[h.id].weight, 0);
              assert.equal(s.riskWeight, weight, where + " risk weight");
              assert.equal(s.riskUnits, s.distanceUnits * weight, where + " risk row maths");
            });
            assert.equal(r.hazards.length, r.segments.reduce((t, s) => t + s.hazards.length, 0), where + " hazard list");
            // Comparison values are exact differences of displayed values.
            assert.equal(r.extraTimeUnits, r.timeUnits - res.recommended.timeUnits, where);
            assert.equal(r.extraDistanceUnits, r.distanceUnits - res.recommended.distanceUnits, where);
            assert.equal(r.extraRiskUnits, r.riskUnits - res.recommended.riskUnits, where);
            // Ranked by the priority; recommendation is first.
            assert.equal(r.rank, i + 1, where);
            assert.equal(r.isRecommended, i === 0, where);
            if (i > 0) assert.ok(r[key] >= res.routes[i - 1][key], where + " not sorted");
            // Labels match their ratios.
            assert.equal(r.congestion.key, E.classify(r.timeUnits / r.freeFlowUnits).key, where);
            assert.equal(r.safety.key, E.classifySafety(r.riskUnits / r.distanceUnits).key, where);
            // Route names are unique.
            assert.equal(res.routes.filter((x) => x.name === r.name).length, 1, where + " duplicate name");
          });
        }
      }
    }
  }
  assert.ok(pairsChecked > 4000, "expected to check many pairs, got " + pairsChecked);
  assert.ok(pairsWithAlternatives > 3000);
});

test("emergency route is the fastest to the nearest hospital from everywhere, under every condition", () => {
  for (const sc of allConditions()) {
    for (const o of D.NODES) {
      const res = E.findEmergencyRoute(D, sc.levels, o.id);
      const where = `${sc.id} ${o.id}`;
      if (o.kind === "hospital") {
        assert.equal(res.code, "AT_HOSPITAL", where);
        continue;
      }
      const times = D.NODES.filter((n) => n.kind === "hospital")
        .flatMap((h) => allSimplePaths(sc.levels, o.id, h.id).map((p) => p.timeUnits));
      if (!times.length) {
        assert.equal(res.code, "UNREACHABLE", where);
        continue;
      }
      assert.equal(res.ok, true, where);
      assert.equal(res.recommended.timeUnits, Math.min(...times), where + " not the fastest");
    }
  }
});

test("vehicle types: walking ignores traffic, two-wheelers lose less time in jams, autos are capped", () => {
  const rush = levelsFor("rush");
  const off = levelsFor("offpeak");
  // Walking: traffic makes no difference, and the time is distance at 4.5 km/h.
  const walkRush = E.findRoutes(D, rush, "BUS", "COL", { vehicle: "walk" });
  const walkOff = E.findRoutes(D, off, "BUS", "COL", { vehicle: "walk" });
  assert.equal(walkRush.vehicle, "walk");
  assert.equal(walkRush.recommended.timeUnits, walkOff.recommended.timeUnits);
  for (const s of walkRush.recommended.segments) {
    assert.equal(s.freeFlowKmh, 4.5);
    assert.equal(s.factor, 1);
  }
  assert.equal(walkRush.recommended.congestion.key, "light");
  // Two-wheeler in the rush: heavy x2.5 becomes x1.9, so never slower than a car.
  const car = E.findRoutes(D, rush, "BUS", "COL", { vehicle: "car" });
  const bike = E.findRoutes(D, rush, "BUS", "COL", { vehicle: "twowheeler" });
  assert.ok(bike.recommended.timeUnits <= car.recommended.timeUnits);
  const heavy = bike.recommended.segments.concat(...bike.routes.map((r) => r.segments)).find((s) => s.level === "heavy");
  if (heavy) assert.equal(heavy.factor, 1.9);
  // Auto-rickshaw: the 50 km/h bypass is capped at 35 km/h.
  const auto = E.findRoutes(D, off, "BUS", "RNG", { vehicle: "auto" });
  assert.ok(auto.recommended.segments.every((s) => s.freeFlowKmh <= 35));
  // Unknown vehicle falls back to car.
  assert.equal(E.findRoutes(D, off, "BUS", "COL", { vehicle: "rocket" }).vehicle, "car");
  assert.deepEqual(E.findRoutes(D, off, "BUS", "COL", { vehicle: "rocket" }).recommended.nodes, ["BUS", "CLK", "TWN", "COL"]);
});

test("every pair, every vehicle: the recommendation is truly fastest for that vehicle", () => {
  const levels = levelsFor("rush");
  for (const vehicle of Object.keys(E.VEHICLES)) {
    const graph = E.buildGraph(D, levels, "fastest", vehicle);
    for (const o of D.NODES) {
      for (const d of D.NODES) {
        if (o.id === d.id) continue;
        const res = E.findRoutes(D, levels, o.id, d.id, { vehicle });
        const where = `${vehicle} ${o.id}->${d.id}`;
        // Brute force over simple paths with this vehicle's edge times.
        let best = Infinity;
        (function dfs(node, seen, time) {
          if (node === d.id) { best = Math.min(best, time); return; }
          for (const { to, edgeId } of graph.adj[node]) {
            if (seen.has(to)) continue;
            seen.add(to);
            dfs(to, seen, time + graph.edgeInfo[edgeId].timeUnits);
            seen.delete(to);
          }
        })(o.id, new Set([o.id]), 0);
        if (best === Infinity) { assert.equal(res.ok, false, where); continue; }
        assert.equal(res.recommended.timeUnits, best, where);
        const em = E.findEmergencyRoute(D, levels, o.id, { vehicle });
        if (o.kind !== "hospital") assert.equal(em.vehicle, vehicle, where + " emergency vehicle");
      }
    }
  }
});
