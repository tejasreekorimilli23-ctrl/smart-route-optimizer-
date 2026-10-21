/*
 * Turn-by-turn directions tests. Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../js/network-data.js");
const R = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");
const Dir = require("../js/directions.js");

const index = (data) => ({
  nodeById: Object.fromEntries(data.NODES.map((n) => [n.id, n])),
  edgeById: Object.fromEntries(data.EDGES.map((e) => [e.id, e]))
});

test("turn angles are classified the way a driver would say them", () => {
  assert.equal(Dir.classify(5), "straight");
  assert.equal(Dir.classify(-40), "slight-left");
  assert.equal(Dir.classify(40), "slight-right");
  assert.equal(Dir.classify(90), "right");
  assert.equal(Dir.classify(-90), "left");
  assert.equal(Dir.classify(170), "uturn");
  assert.equal(Dir.turnAngle(350, 10), 20, "turning across north");
  assert.equal(Dir.turnAngle(10, 350), -20);
  // Heading north then east is a right turn.
  const north = Dir.bearing({ lat: 18.1, lon: 83.4 }, { lat: 18.101, lon: 83.4 });
  const east = Dir.bearing({ lat: 18.1, lon: 83.4 }, { lat: 18.1, lon: 83.401 });
  assert.equal(Dir.classify(Dir.turnAngle(north, east)), "right");
});

function checkSteps(data, route, where) {
  const { nodeById, edgeById } = index(data);
  const steps = Dir.build(route, edgeById, nodeById);
  assert.ok(steps.length >= 2, where + " too few steps");
  assert.equal(steps[0].kind, "depart", where);
  assert.equal(steps[steps.length - 1].kind, "arrive", where);
  steps.slice(1, -1).forEach((s) => assert.equal(s.kind, "turn", where));
  // The legs cover the whole route except the short access paths to places.
  const roadUnits = route.segments.filter((s) => edgeById[s.edgeId].type !== "access").reduce((a, s) => a + s.distanceUnits, 0);
  assert.equal(steps.reduce((a, s) => a + s.units, 0), roadUnits, where + " legs do not add up to the route");
  // No step tells you to turn onto the road you are already on.
  for (let i = 1; i < steps.length - 1; i++) {
    const a = edgeById[steps[i - 1].roadEdgeId];
    const b = edgeById[steps[i].roadEdgeId];
    const key = (e) => (e.corridor !== undefined ? e.corridor || "~" + e.type : e.name);
    assert.notEqual(key(a), key(b), where + " repeats a road");
  }
  return steps;
}

test("demo town: every route has complete, consistent directions", () => {
  const levels = E.levelsForScenario(D, "offpeak");
  for (const o of D.NODES) for (const d of D.NODES) {
    if (o.id === d.id) continue;
    const res = E.findRoutes(D, levels, o.id, d.id);
    res.routes.forEach((r) => checkSteps(D, r, `${o.id}->${d.id}`));
  }
  const res = E.findRoutes(D, levels, "BUS", "COL");
  const steps = checkSteps(D, res.recommended, "BUS->COL");
  assert.equal(steps.length, 3, "MG Road then University Avenue");
  assert.equal(steps[0].compass, "east");
});

test("real map: sample routes have complete, consistent directions", () => {
  const places = R.NODES.filter((n) => n.category);
  const levels = E.levelsForHour(R, 12);
  for (let i = 0; i < 20; i++) {
    const o = places[(i * 37) % places.length];
    const d = places[(i * 53 + 11) % places.length];
    if (o.id === d.id) continue;
    const res = E.findRoutes(R, levels, o.id, d.id);
    res.routes.forEach((r) => checkSteps(R, r, `${o.name} -> ${d.name}`));
  }
});
