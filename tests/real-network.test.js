/*
 * Tests for the real-map mode: the OpenStreetMap road network of the area,
 * routing on it, emergency mode and GPS / map-click pins. Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const R = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");
const G = require("../js/geo-tools.js");

const nodeById = Object.fromEntries(R.NODES.map((n) => [n.id, n]));
const places = R.NODES.filter((n) => n.category);
const byName = (name) => places.find((p) => p.name === name || p.name.startsWith(name + " ("));

/** Deterministic pseudo-random place pairs (no Math.random, so failures repeat). */
function samplePairs(count) {
  const out = [];
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  while (out.length < count) {
    const a = places[Math.floor(next() * places.length)];
    const b = places[Math.floor(next() * places.length)];
    if (a.id !== b.id) out.push([a.id, b.id]);
  }
  return out;
}

/** Checks a route is a real drivable path: connected, open, one-way rules kept, no repeated stop. */
function assertDrivable(route, levels, where) {
  assert.equal(new Set(route.nodes).size, route.nodes.length, where + " repeats a stop");
  route.edges.forEach((eid, i) => {
    const e = R.EDGES.find((x) => x.id === eid) || null;
    assert.ok(e, where + " unknown road " + eid);
    const a = route.nodes[i];
    const b = route.nodes[i + 1];
    const forward = e.from === a && e.to === b;
    const backward = e.from === b && e.to === a;
    assert.ok(forward || (backward && !e.oneway), where + " drives " + e.name + " the wrong way or is broken");
    assert.notEqual(levels[eid], "closed", where + " uses a closed road");
  });
}

test("real network data is consistent", () => {
  assert.equal(R.UNITS.distancePerKm, 1000);
  assert.equal(R.UNITS.timePerMin, 60);
  assert.ok(R.NODES.length > 1000 && R.EDGES.length > 1000, "network looks too small");
  assert.equal(new Set(R.NODES.map((n) => n.id)).size, R.NODES.length, "duplicate node id");
  assert.equal(new Set(R.EDGES.map((e) => e.id)).size, R.EDGES.length, "duplicate road id");
  const [s, w, n, e] = R.AREA.bbox;
  for (const node of R.NODES) {
    assert.ok(node.name, node.id + " has no name");
    assert.ok(node.lat > s - 0.01 && node.lat < n + 0.01 && node.lon > w - 0.01 && node.lon < e + 0.01, node.id + " outside the area");
  }
  for (const edge of R.EDGES) {
    assert.ok(nodeById[edge.from] && nodeById[edge.to], edge.id + " has unknown ends");
    assert.notEqual(edge.from, edge.to, edge.id + " is a loop");
    assert.ok(edge.distanceKm > 0, edge.id + " has no length");
    assert.ok(R.ROAD_TYPES[edge.type], edge.id + " has unknown type " + edge.type);
    assert.ok(edge.geom.length >= 4 && edge.geom.length % 2 === 0, edge.id + " bad geometry");
    for (const h of edge.hazards) assert.ok(R.HAZARDS[h], edge.id + " unknown hazard " + h);
    // Geometry starts at "from" and ends at "to" (within rounding).
    const f = nodeById[edge.from];
    const t = nodeById[edge.to];
    assert.ok(Math.abs(edge.geom[0] - f.lat) < 1e-4 && Math.abs(edge.geom[1] - f.lon) < 1e-4, edge.id + " geometry start");
    const k = edge.geom.length;
    assert.ok(Math.abs(edge.geom[k - 2] - t.lat) < 1e-4 && Math.abs(edge.geom[k - 1] - t.lon) < 1e-4, edge.id + " geometry end");
  }
  assert.ok(places.filter((p) => p.kind === "hospital").length >= 10, "expected many hospitals");
  assert.ok(byName("Thotapalem"), "Thotapalem is searchable");
  assert.equal(R.DEFAULTS.origin, byName("Thotapalem").id);
  assert.equal(nodeById[R.DEFAULTS.destination].name, "Vizianagaram Junction");
  // Eye and dental hospitals are not used for emergencies.
  for (const p of places.filter((x) => x.kind === "hospital")) {
    if (/\b(eye|dental)\b/i.test(p.name)) assert.equal(p.emergency, false, p.name);
  }
});

test("every location can reach every other one, respecting one-way streets", () => {
  const graph = E.buildGraph(R, null);
  const reach = (start, reverse) => {
    const adj = {};
    for (const id of Object.keys(graph.adj)) adj[id] = [];
    for (const [id, list] of Object.entries(graph.adj)) {
      for (const { to } of list) (reverse ? adj[to] : adj[id]).push(reverse ? id : to);
    }
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const v of adj[stack.pop()]) if (!seen.has(v)) { seen.add(v); stack.push(v); }
    return seen.size;
  };
  assert.equal(reach(R.DEFAULTS.origin, false), R.NODES.length, "some places cannot be reached from Thotapalem");
  assert.equal(reach(R.DEFAULTS.origin, true), R.NODES.length, "some places cannot get back to Thotapalem");
});

test("time-of-day rules: rush hour jams main roads and school zones, early morning is clear", () => {
  const early = E.levelsForHour(R, 6);
  assert.ok(Object.values(early).every((lv) => lv === "light"));
  const rush = E.levelsForHour(R, 9);
  for (const e of R.EDGES) {
    if (e.type === "primary") assert.equal(rush[e.id], "heavy", e.name);
    if (e.hazards.includes("school")) assert.equal(rush[e.id], "heavy", e.name + " near a school");
  }
  const evening = E.levelsForHour(R, 18);
  for (const e of R.EDGES) if (e.hazards.includes("market")) assert.equal(evening[e.id], "heavy", e.name + " near a market");
});

test("sample routes: drivable, truly best, totals exact, fast enough", () => {
  const pairs = samplePairs(12);
  let slowest = 0;
  for (const hour of [9, 12, 18]) {
    const levels = E.levelsForHour(R, hour);
    const fastGraph = E.buildGraph(R, levels, "fastest");
    const safeGraph = E.buildGraph(R, levels, "safest");
    for (const [o, d] of pairs) {
      for (const priority of ["fastest", "safest"]) {
        const where = `${hour}:00 ${priority} ${nodeById[o].name} -> ${nodeById[d].name}`;
        const t0 = Date.now();
        const res = E.findRoutes(R, levels, o, d, { priority });
        slowest = Math.max(slowest, Date.now() - t0);
        assert.equal(res.ok, true, where);
        const optTime = E.dijkstra(fastGraph, o, d).timeUnits;
        const optRisk = E.dijkstra(safeGraph, o, d).riskUnits;
        if (priority === "fastest") assert.equal(res.recommended.timeUnits, optTime, where + " not fastest");
        else assert.equal(res.recommended.riskUnits, optRisk, where + " not safest");
        assert.equal(res.routes.find((r) => r.isFastest).timeUnits, optTime, where + " fastest badge");
        assert.equal(res.routes.find((r) => r.isSafest).riskUnits, optRisk, where + " safest badge");
        assert.ok(res.routes.length <= Math.max(E.SETTINGS.maxRoutes, Object.keys(E.PRIORITIES).length), where);
        assert.equal(new Set(res.routes.map((r) => r.signature)).size, res.routes.length, where + " duplicate route");
        res.routes.forEach((r) => {
          assertDrivable(r, levels, where);
          const sum = (f) => r.segments.reduce((s, x) => s + x[f], 0);
          assert.equal(r.timeUnits, sum("timeUnits"), where + " time total");
          assert.equal(r.distanceUnits, sum("distanceUnits"), where + " distance total");
          assert.equal(r.riskUnits, sum("riskUnits"), where + " risk total");
          assert.equal(r.nodes[0], o);
          assert.equal(r.nodes[r.nodes.length - 1], d);
        });
      }
    }
  }
  assert.ok(slowest < 3000, "a search took " + slowest + " ms");
});

test("closing a road makes the route avoid it", () => {
  const levels = E.levelsForHour(R, 12);
  const first = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination);
  const blocked = first.recommended.edges.find((id) => !id.startsWith("a"));
  const closed = { ...levels, [blocked]: "closed" };
  const again = E.findRoutes(R, closed, R.DEFAULTS.origin, R.DEFAULTS.destination);
  assert.equal(again.ok, true);
  for (const r of again.routes) assert.ok(!r.edges.includes(blocked), "route still uses the closed road");
});

test("emergency picks the hospital with the shortest journey time", () => {
  const levels = E.levelsForHour(R, 18);
  const graph = E.buildGraph(R, levels, "fastest");
  const hospitals = places.filter((p) => p.kind === "hospital" && p.emergency !== false);
  for (const origin of ["Thotapalem", "Vizianagaram Junction", "Gajula Rega"]) {
    const o = byName(origin).id;
    const res = E.findEmergencyRoute(R, levels, o);
    assert.equal(res.ok, true, origin);
    assert.notEqual(res.hospital.emergency, false, origin + " sent to an eye/dental hospital");
    const best = Math.min(...hospitals.map((h) => E.dijkstra(graph, o, h.id).timeUnits));
    assert.equal(res.recommended.timeUnits, best, origin + " not the nearest hospital by time");
    assert.equal(res.nearestHospitals[0].hospital.id, res.hospital.id);
    assert.ok(res.nearestHospitals.length === 3);
    for (let i = 1; i < 3; i++) assert.ok(res.nearestHospitals[i].timeUnits >= res.nearestHospitals[i - 1].timeUnits);
  }
});

test("GPS / map-click pins join the nearest road and can be routed from", () => {
  const thota = byName("Thotapalem");
  const pin = G.pinToRoad(R, "u-start", "My location", thota.lat + 0.0005, thota.lon + 0.0005);
  assert.ok(pin, "pin near Thotapalem should work");
  assert.equal(pin.edges.length, 2);
  assert.ok(pin.offsetMetres < G.MAX_PIN_METRES);
  const parent = pin.road;
  assert.equal(pin.edges[0].from, parent.from);
  assert.equal(pin.edges[1].to, parent.to);
  if (parent.oneway) assert.ok(pin.edges.every((e) => e.oneway));
  const data = { ...R, NODES: R.NODES.concat([pin.node]), EDGES: R.EDGES.concat(pin.edges) };
  const res = E.findRoutes(data, E.levelsForHour(data, 12), "u-start", R.DEFAULTS.destination);
  assert.equal(res.ok, true);
  assert.equal(res.origin.name, "My location");

  assert.equal(G.pinToRoad(R, "u-x", "Far away", 18.4, 83.7), null, "a point far outside the map is refused");
});

test("black spots mark nearby roads, and the safest route avoids them when it can", () => {
  const data = { ...R, EDGES: R.EDGES.map((e) => ({ ...e, hazards: e.hazards.slice() })) };
  const levels = E.levelsForHour(data, 12);
  const before = E.findRoutes(data, levels, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority: "safest" });
  // Put a (test-only) black spot on the middle of the current safest route.
  const mid = before.recommended.segments[Math.floor(before.recommended.segments.length / 2)];
  const e = data.EDGES.find((x) => x.id === mid.edgeId);
  const spot = { name: "Test spot", lat: e.geom[0], lon: e.geom[1], radiusMetres: 30 };
  const marked = G.applyBlackspots(data, [spot]);
  assert.ok(marked >= 1);
  assert.ok(data.EDGES.find((x) => x.id === mid.edgeId).hazards.includes("blackspot"));
  assert.ok(!R.EDGES.find((x) => x.id === mid.edgeId).hazards.includes("blackspot"), "original data unchanged");
  const after = E.findRoutes(data, levels, R.DEFAULTS.origin, R.DEFAULTS.destination, { priority: "safest" });
  const usesSpot = after.recommended.hazards.some((h) => h.id === "blackspot");
  if (usesSpot) {
    // Only acceptable if every route to there has to pass it.
    assert.ok(after.recommended.riskUnits <= before.recommended.riskUnits + 3 * mid.distanceUnits * 2);
  } else {
    assert.ok(!after.recommended.edges.includes(mid.edgeId));
  }
});

test("the committed map file matches a fresh build from the downloaded data", () => {
  const raw = path.join(__dirname, "..", "data", "osm");
  if (!fs.existsSync(path.join(raw, "roads.json"))) return; // download not present: nothing to compare
  const { buildNetwork } = require("../scripts/build-real-network.js");
  const AREA = require("../scripts/real-area.config.js");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(raw, f), "utf8"));
  const fresh = buildNetwork(read("roads.json"), read("places.json"), AREA);
  assert.equal(fresh.NODES.length, R.NODES.length, "run npm run build-map");
  assert.equal(fresh.EDGES.length, R.EDGES.length, "run npm run build-map");
  assert.deepEqual(fresh.DEFAULTS, R.DEFAULTS);
});

test("walking may use one-way streets both ways; vehicles may not", () => {
  const oneway = R.EDGES.find((e) => e.oneway && e.type !== "access");
  assert.ok(oneway, "the map should have one-way streets");
  const car = E.buildGraph(R, null, "fastest", "car");
  const walk = E.buildGraph(R, null, "fastest", "walk");
  const back = (g) => g.adj[oneway.to].some((x) => x.edgeId === oneway.id);
  assert.equal(back(car), false, "a car must not drive " + oneway.name + " backwards");
  assert.equal(back(walk), true, "a walker may walk " + oneway.name + " both ways");
  const res = E.findRoutes(R, E.levelsForHour(R, 9), R.DEFAULTS.origin, R.DEFAULTS.destination, { vehicle: "twowheeler" });
  assert.equal(res.ok, true);
  res.routes.forEach((r) => assertDrivable(r, E.levelsForHour(R, 9), "two-wheeler"));
});
