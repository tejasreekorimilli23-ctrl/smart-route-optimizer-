/*
 * Trip mode logic: following a route with simulated GPS positions.
 * Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");
const Dir = require("../js/directions.js");
const Trip = require("../js/trip.js");

const nodeById = Object.fromEntries(R.NODES.map((n) => [n.id, n]));
const edgeById = Object.fromEntries(R.EDGES.map((e) => [e.id, e]));

function setup() {
  const route = E.findRoutes(R, E.levelsForHour(R, 12), R.DEFAULTS.origin, R.DEFAULTS.destination).recommended;
  const ln = Trip.line(route, edgeById);
  const steps = Dir.build(route, edgeById, nodeById);
  return { route, ln, steps, alongs: Trip.stepAlongs(ln, steps) };
}

/** A point `metres` along the route (simulated GPS on the road). */
function pointAt(ln, metres) {
  for (let i = 1; i < ln.pts.length; i++) {
    const a = ln.pts[i - 1];
    const b = ln.pts[i];
    if (b.along >= metres) {
      const t = (metres - a.along) / (b.along - a.along || 1);
      return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
    }
  }
  return ln.pts[ln.pts.length - 1];
}

test("the route line is continuous and as long as the route", () => {
  const { route, ln } = setup();
  const metres = (route.distanceUnits / E.unitsOf(R).perKm) * 1000;
  assert.ok(Math.abs(ln.length - metres) < metres * 0.02 + 5, ln.length + " vs " + metres);
  assert.equal(ln.timeUnits, route.timeUnits);
  for (let i = 1; i < ln.pts.length; i++) assert.ok(ln.pts[i].along >= ln.pts[i - 1].along);
});

test("positions along the route give the right next step and time left", () => {
  const { ln, steps, alongs } = setup();
  const start = Trip.status(ln, alongs, Trip.locate(ln, pointAt(ln, 5)));
  assert.equal(start.nextIndex, 1, "first turn is next");
  assert.ok(Math.abs(start.toNextMetres - (alongs[1] - 5)) < 3);
  assert.ok(start.remainingUnits > 0);
  // Halfway: a later step is next and less time is left.
  const half = Trip.status(ln, alongs, Trip.locate(ln, pointAt(ln, ln.length / 2)));
  assert.ok(half.nextIndex > 1);
  assert.ok(half.remainingUnits < start.remainingUnits);
  assert.equal(half.arrived, false);
  // At the end: arrived, and the next step is "arrive".
  const end = Trip.status(ln, alongs, Trip.locate(ln, pointAt(ln, ln.length - 5)));
  assert.equal(end.arrived, true);
  assert.equal(steps[end.nextIndex].kind, "arrive");
});

test("leaving the route is noticed after two positions in a row", () => {
  const { ln } = setup();
  const off = Trip.offRouteCounter();
  const on = Trip.locate(ln, pointAt(ln, 100));
  assert.equal(off(on), false);
  const away = pointAt(ln, 100);
  const far = Trip.locate(ln, { lat: away.lat + 0.002, lon: away.lon + 0.002 }); // ~300 m away
  assert.ok(far.offset > Trip.SETTINGS.offRouteMetres);
  assert.equal(off(far), false, "one stray GPS position is not enough");
  assert.equal(off(far), true);
  assert.equal(off(on), false, "back on the route");
});

test("real speeds are measured on road sections passed from end to end", () => {
  const { ln } = setup();
  const track = Trip.speedTracker(ln);
  const kmh = 18;
  const mps = (kmh * 1000) / 3600;
  const results = [];
  for (let m = 0; m <= ln.length; m += 10) {
    const r = track(Trip.locate(ln, pointAt(ln, m)), (m / mps) * 1000);
    if (r) results.push(r);
  }
  assert.ok(results.length >= 1, "some sections were measured");
  for (const r of results) assert.ok(Math.abs(r.kmh - kmh) < 4, JSON.stringify(r));
});

test("spoken reminders come at 200 m and 50 m, once each", () => {
  const said = [];
  assert.equal(Trip.reminderDue(500, said), null);
  const first = Trip.reminderDue(190, said);
  assert.equal(first, 200);
  said.push(first);
  assert.equal(Trip.reminderDue(150, said), null);
  assert.equal(Trip.reminderDue(40, said), 50);
});
