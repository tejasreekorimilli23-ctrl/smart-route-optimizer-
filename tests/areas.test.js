/*
 * Switching between areas (towns / cities): area sizes, trips across a
 * city, only the newest download is used, and data from one area's map is
 * never applied to another area's roads by id. Run with: npm test
 *
 * These tests use the downloaded OpenStreetMap data in data/osm/ (no
 * internet). Coordinates of Visakhapatnam places come from OpenStreetMap's
 * search (Nominatim), looked up when the tests were written.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../js/area-loader.js");
const E = require("../js/route-engine.js");
const OSM = require("../js/osm-network.js");
const G = require("../js/geo-tools.js");
const CM = require("../js/community.js");
const BUILT_IN = require("../js/real-network-data.js");

const OSM_DIR = path.join(__dirname, "..", "data", "osm");
const haveOsm = fs.existsSync(path.join(OSM_DIR, "roads.json"));

// Visakhapatnam, as OpenStreetMap's search returns it: the point and the
// city's outline (about 35 x 34 km).
const VIZAG = { name: "Visakhapatnam", lat: 17.6935526, lon: 83.2921297, box: [17.5336, 83.1321, 17.8536, 83.4521] };
const PM_PALEM = { lat: 17.8018, lon: 83.3546 }; // Pothinamallayyapalem (the GPS area in the bug report)
const HANUMANTHUWAKA = { lat: 17.7604, lon: 83.3301 };
const VIZIANAGARAM = { lat: 18.1067, lon: 83.3956 };

test("a whole city is too big: the centre is loaded and the user is told", () => {
  const info = A.boxInfo(VIZAG);
  assert.equal(info.cropped, true);
  assert.ok(Math.abs(info.span.ns - 8) < 0.2 && Math.abs(info.span.ew - 8) < 0.2, JSON.stringify(info.span));
  assert.ok(info.full.ns > 30 && info.full.ew > 30);
  // A town-sized outline is used as it is and is not "cropped".
  const town = { lat: 18.3, lon: 83.9, box: [18.27, 83.87, 18.33, 83.93] };
  assert.equal(A.boxInfo(town).cropped, false);
});

test("the bug report's trip: Pothinamallayyapalem to Hanumanthuwaka fits in one area", () => {
  // The 8 km square around the user did not contain Hanumanthuwaka...
  const around = A.square(PM_PALEM.lat, PM_PALEM.lon, A.SETTINGS.squareKm / 2);
  assert.equal(A.contains(around, HANUMANTHUWAKA), false, "this is why the destination could not be used");
  // ...but one area covering both ends does, within the size limit.
  const both = A.boxAround(PM_PALEM, HANUMANTHUWAKA);
  assert.ok(both, "both ends fit");
  assert.ok(A.contains(both, PM_PALEM) && A.contains(both, HANUMANTHUWAKA));
  assert.ok(A.areaKm2(both) <= A.SETTINGS.maxAreaKm2, A.areaKm2(both) + " km2");
  assert.ok(Math.abs(A.distanceKm(PM_PALEM, HANUMANTHUWAKA) - 5.3) < 0.3);
});

test("trips too long for one area are refused instead of loading a huge area", () => {
  assert.equal(A.boxAround(VIZIANAGARAM, VIZAG), null, "Vizianagaram to Visakhapatnam (~45 km)");
  // 14 km diagonal: under the 25 km span but over the area limit.
  const a = { lat: 17.70, lon: 83.20 };
  const b = { lat: 17.79, lon: 83.30 };
  assert.ok(A.distanceKm(a, b) > 13);
  assert.equal(A.boxAround(a, b), null);
});

test("only the newest area load counts; an older answer arriving later is ignored", () => {
  const s = A.session();
  const first = s.begin(); // e.g. "Use my location" starts loading
  const second = s.begin(); // then the user searches a city
  assert.equal(s.isCurrent(first), false, "the GPS area must not replace the city chosen later");
  assert.equal(s.isCurrent(second), true);
  assert.equal(s.busy(), true);
  s.end(first); // ending an old load does not clear "busy"
  assert.equal(s.busy(), true);
  s.end(second);
  assert.equal(s.busy(), false);
});

/** A second area built from the same OpenStreetMap data, over part of the built-in box. */
function subArea() {
  const roads = JSON.parse(fs.readFileSync(path.join(OSM_DIR, "roads.json"), "utf8"));
  const places = JSON.parse(fs.readFileSync(path.join(OSM_DIR, "places.json"), "utf8"));
  const box = [18.095, 83.385, 18.130, 83.430];
  const data = OSM.buildNetwork(roads, places, OSM.areaSettings("Part of town", box, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]));
  data.AREA.key = box.join(",");
  return data;
}

function mid(e) {
  const i = Math.floor(e.geom.length / 4) * 2;
  return { lat: e.geom[i], lon: e.geom[i + 1] };
}

test("the same road id means different roads in two areas (why ids are never trusted across areas)", { skip: !haveOsm }, () => {
  const other = subArea();
  const byId = Object.fromEntries(other.EDGES.map((e) => [e.id, e]));
  const clash = BUILT_IN.EDGES.filter((e) => byId[e.id] && G.haversine(mid(e), mid(byId[e.id])) > 100);
  assert.ok(clash.length > 100, clash.length + " ids that point to different roads");
});

test("reports and alerts are placed on the current area's roads by position, not by id", { skip: !haveOsm }, () => {
  const other = subArea();
  const ctx = (data, key, builtIn) => ({ key, builtIn, bbox: data.AREA.bbox, nearest: (lat, lon) => G.nearestRoad(data, lat, lon) });
  // A named main road in the middle of the sub-area.
  const e = BUILT_IN.EDGES.find((x) => x.corridor && x.distanceKm > 0.15 && A.contains(other.AREA.bbox, mid(x)) &&
    A.contains([18.10, 83.39, 18.125, 83.425], mid(x)));
  assert.ok(e, "a test road");
  const p = mid(e);
  const report = { id: "r1", type: "closed", lat: p.lat, lon: p.lon, edgeId: e.id, roadName: e.name, expiresAt: new Date(Date.now() + 3600e3), confirms: 0, clears: 0 };

  const onOther = CM.forArea([report], [], ctx(other, other.AREA.key, false)).reports[0];
  assert.ok(onOther, "the report is kept");
  const placed = other.EDGES.find((x) => x.id === onOther.edgeId);
  assert.equal(placed.name, e.name, "same road, found by position");
  assert.ok(G.haversine(mid(placed), p) < 200);

  // An alert made on the built-in map, with the middle points of its roads.
  const alert = { kind: "closure", edges: [e.id], points: [p.lat, p.lon], areaKey: "builtin", bbox: BUILT_IN.AREA.bbox };
  const a1 = CM.forArea([], [alert], ctx(other, other.AREA.key, false)).alerts[0];
  assert.equal(a1.edges.length, 1);
  assert.equal(other.EDGES.find((x) => x.id === a1.edges[0]).name, e.name);
  assert.equal(a1.here, true);
  const a2 = CM.forArea([], [alert], ctx(BUILT_IN, "builtin", true)).alerts[0];
  assert.deepEqual(a2.edges, [e.id], "on its own map the alert keeps its roads");

  // An older alert without points or area: only used on the built-in map.
  const legacy = { kind: "closure", edges: [e.id] };
  assert.deepEqual(CM.forArea([], [legacy], ctx(other, other.AREA.key, false)).alerts[0].edges, []);
  assert.deepEqual(CM.forArea([], [legacy], ctx(BUILT_IN, "builtin", true)).alerts[0].edges, [e.id]);

  // An alert for a far-away area shows nothing here (no banner, no roads).
  const far = { kind: "bandh", edges: ["e1"], points: [17.70, 83.29], areaKey: "17.65,83.25,17.73,83.33", bbox: [17.65, 83.25, 17.73, 83.33] };
  const a3 = CM.forArea([], [far], ctx(BUILT_IN, "builtin", true)).alerts[0];
  assert.deepEqual(a3.edges, []);
  assert.equal(a3.here, false);

  // The closure closes that road for routing on the other map.
  const fx = CM.effects([onOther], [], new Date());
  assert.equal(fx.levels[placed.id], "closed");

  // A report far from any road of this area is dropped, not attached to a random road.
  const lost = { ...report, lat: 17.70, lon: 83.29 };
  assert.equal(CM.forArea([lost], [], ctx(other, other.AREA.key, false)).reports.length, 0);
});

test("a second area is routable on its own graph, and the built-in map is unchanged by it", { skip: !haveOsm }, () => {
  const before = JSON.stringify(BUILT_IN.EDGES.slice(0, 50));
  const other = subArea();
  const places = other.NODES.filter((n) => n.category);
  const r = E.findRoutes(other, E.levelsForHour(other, 9), places[0].id, places[places.length - 1].id, { priority: "shortest" });
  assert.equal(r.ok, true);
  const ids = new Set(other.EDGES.map((e) => e.id));
  r.routes.forEach((route) => route.edges.forEach((id) => assert.ok(ids.has(id))));
  assert.equal(JSON.stringify(BUILT_IN.EDGES.slice(0, 50)), before, "building another area does not touch the built-in map");
  assert.ok(other.STATS.sectionsKept <= other.STATS.sectionsFound && other.STATS.sectionsKept > 500);
});
