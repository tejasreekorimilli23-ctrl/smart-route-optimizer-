/*
 * Builds js/real-network-data.js from the OpenStreetMap download in data/osm/.
 *     npm run build-map
 *
 * What it does:
 *  1. Keeps drivable roads (no private roads, parking aisles or driveways)
 *     and reads one-way rules, posted speed limits, lighting and footpath tags.
 *  2. Splits roads into sections between junctions, then joins sections that
 *     only continue the same road, so the graph stays small and fast.
 *  3. Keeps the largest part of the network where every junction can reach
 *     every other one (respecting one-way streets), so a route always exists.
 *  4. Adds named places (hospitals, colleges, areas, the railway station...)
 *     as locations, each joined to its nearest road by a short access path.
 *  5. Marks road-safety hazards: school/college zones and crowded market areas
 *     (by distance), highways with heavy vehicles, busy junctions, unlit roads
 *     and roads without footpaths (from tags). Accident black spots are added
 *     in the browser from js/blackspots.js.
 *
 * The output has the same shape as the demo town (js/network-data.js), so the
 * same route engine works on both. Units: metres and seconds.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const AREA = require("./real-area.config.js");
const DEMO = require("../js/network-data.js");

// Assumed free-flow speeds (km/h) for an Indian town, per OpenStreetMap road
// class. A lower posted speed limit on a road replaces its value.
const ROAD_TYPES = {
  trunk: { label: "National highway", freeFlowKmh: 50 },
  trunk_link: { label: "Highway slip road", freeFlowKmh: 35 },
  motorway: { label: "Expressway", freeFlowKmh: 60 },
  motorway_link: { label: "Expressway slip road", freeFlowKmh: 40 },
  primary: { label: "Main road", freeFlowKmh: 40 },
  primary_link: { label: "Main road link", freeFlowKmh: 30 },
  secondary: { label: "Secondary road", freeFlowKmh: 35 },
  secondary_link: { label: "Secondary road link", freeFlowKmh: 30 },
  tertiary: { label: "Local main road", freeFlowKmh: 30 },
  tertiary_link: { label: "Local main road link", freeFlowKmh: 25 },
  unclassified: { label: "Minor road", freeFlowKmh: 25 },
  road: { label: "Road", freeFlowKmh: 20 },
  residential: { label: "Residential street", freeFlowKmh: 20 },
  living_street: { label: "Living street", freeFlowKmh: 10 },
  service: { label: "Service lane", freeFlowKmh: 15 },
  access: { label: "Access path", freeFlowKmh: 10 }
};
const MAJOR = new Set(["trunk", "motorway", "primary", "secondary", "tertiary"]);
const SKIP_SERVICE = new Set(["parking_aisle", "driveway", "drive-through", "emergency_access"]);

const HAZARDS = {
  blackspot: { label: "Accident black spot", weight: 3 },
  school: { label: "School or college zone", weight: 2 },
  market: { label: "Crowded market or shopping area", weight: 2 },
  heavyvehicles: { label: "Highway with heavy vehicles", weight: 2 },
  junction: { label: "Busy junction", weight: 1 },
  unlit: { label: "Poor street lighting", weight: 1 },
  nofootpath: { label: "No footpath for pedestrians", weight: 1 }
};
const HAZARD_ORDER = ["blackspot", "school", "market", "heavyvehicles", "junction", "unlit", "nofootpath"];

// Estimated traffic through the day, by road class and by nearby hazard.
// These are planning estimates, not live traffic.
const TIME_BANDS = [
  { from: 6, to: 7, name: "Early morning", description: "Estimated: roads are clear before the day starts.", rules: {} },
  {
    from: 8, to: 10, name: "Morning rush",
    description: "Estimated: main roads are busy with office traffic, and roads near schools and colleges are jammed.",
    rules: {
      types: { trunk: "moderate", primary: "heavy", primary_link: "moderate", secondary: "heavy", tertiary: "moderate" },
      hazards: { school: "heavy", market: "moderate" }
    }
  },
  {
    from: 11, to: 15, name: "Midday",
    description: "Estimated: steady traffic on main roads; market areas are busy.",
    rules: { types: { primary: "moderate", secondary: "moderate" }, hazards: { market: "moderate" } }
  },
  {
    from: 16, to: 16, name: "School closing",
    description: "Estimated: schools and colleges let out, so nearby roads fill up.",
    rules: { types: { primary: "moderate", secondary: "moderate" }, hazards: { school: "heavy" } }
  },
  {
    from: 17, to: 19, name: "Evening rush",
    description: "Estimated: the busiest time. Main roads, markets and big junctions are jammed.",
    rules: {
      types: { trunk: "moderate", primary: "heavy", primary_link: "moderate", secondary: "heavy", tertiary: "moderate" },
      hazards: { market: "heavy", junction: "heavy" }
    }
  },
  {
    from: 20, to: 22, name: "Night",
    description: "Estimated: light traffic, but markets stay busy until late.",
    rules: { hazards: { market: "moderate" } }
  }
];

const PLACE_CATEGORIES = [
  "Areas and junctions",
  "Hospitals",
  "Schools and colleges",
  "Transport",
  "Markets and shopping",
  "Temples, mosques and churches",
  "Other landmarks",
  "Clinics"
];

// ---------- geometry ----------

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Local flat projection in metres; accurate enough over a few km. */
function projector(lat0) {
  const kx = (Math.PI / 180) * R * Math.cos(rad(lat0));
  const ky = (Math.PI / 180) * R;
  return (p) => ({ x: p.lon * kx, y: p.lat * ky });
}

function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---------- roads ----------

function parseSpeed(v) {
  const m = /^(\d+)/.exec(v || "");
  return m ? Number(m[1]) : null;
}

/**
 * Parts of a way inside the area (plus a small margin). Overpass returns
 * whole roads, so long roads stick out of the box; they are cut at the edge.
 */
function insideRuns(nodes, coords, bbox) {
  const m = 0.003;
  const inside = (id) => {
    const c = coords.get(id);
    return c && c.lat >= bbox[0] - m && c.lat <= bbox[2] + m && c.lon >= bbox[1] - m && c.lon <= bbox[3] + m;
  };
  const runs = [];
  let run = [];
  for (const id of nodes) {
    if (inside(id)) {
      run.push(id);
    } else {
      if (run.length >= 2) runs.push(run);
      run = [];
    }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}

function readWays(roads, bbox) {
  const coords = new Map();
  for (const el of roads.elements) if (el.type === "node") coords.set(el.id, { lat: el.lat, lon: el.lon });
  const ways = [];
  for (const el of roads.elements) {
    if (el.type !== "way" || !el.tags) continue;
    const t = el.tags;
    if (!ROAD_TYPES[t.highway] || t.highway === "access") continue;
    if (t.area === "yes" || t.access === "private" || t.access === "no") continue;
    if (t.highway === "service" && SKIP_SERVICE.has(t.service)) continue;
    for (const run of insideRuns(el.nodes, coords, bbox)) addWay(ways, el, run);
  }
  return { coords, ways };
}

function addWay(ways, el, wayNodes) {
  const t = el.tags;
  let nodes = wayNodes;
  let dir = 0;
  if (["yes", "true", "1"].includes(t.oneway)) dir = 1;
  else if (["-1", "reverse"].includes(t.oneway)) dir = -1;
  else if ((t.junction === "roundabout" || t.junction === "circular") && t.oneway !== "no") dir = 1;
  if (dir === -1) nodes = nodes.slice().reverse();
  const hazards = [];
  if (t.highway === "trunk" || t.highway === "trunk_link" || t.highway === "motorway") hazards.push("heavyvehicles");
  if (t.lit === "no") hazards.push("unlit");
  if (t.sidewalk === "no" || t.sidewalk === "none") hazards.push("nofootpath");
  const limit = parseSpeed(t.maxspeed);
  const typeSpeed = ROAD_TYPES[t.highway].freeFlowKmh;
  ways.push({
    id: el.id,
    nodes,
    type: t.highway,
    name: t.name || t["name:en"] || t.ref || "",
    oneway: dir !== 0,
    speed: limit && limit < typeSpeed ? limit : null,
    hazards
  });
}

/** Same road continuing: these two sections may be joined into one. */
function sameRoad(a, b) {
  return a.type === b.type && a.name === b.name && a.oneway === b.oneway && a.speed === b.speed &&
    a.hazards.join() === b.hazards.join() && a.wayKey === b.wayKey;
}

function splitWays(ways, keep) {
  const uses = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      uses.set(id, (uses.get(id) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1));
    });
  }
  const isJunction = (id) => uses.get(id) >= 2 || keep.has(id);
  const segs = [];
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i === w.nodes.length - 1 || isJunction(w.nodes[i])) {
        pushSegment(segs, w, w.nodes.slice(start, i + 1));
        start = i;
      }
    }
  }
  return segs;
}

function pushSegment(segs, w, nodes) {
  const base = { type: w.type, name: w.name, oneway: w.oneway, speed: w.speed, hazards: w.hazards, wayKey: w.wayKey || "" };
  if (nodes[0] === nodes[nodes.length - 1]) {
    // A closed loop (e.g. a roundabout with one exit): split it in the middle
    // so that both halves are usable.
    if (nodes.length < 3) return;
    const mid = Math.floor(nodes.length / 2);
    segs.push({ ...base, nodes: nodes.slice(0, mid + 1) });
    segs.push({ ...base, nodes: nodes.slice(mid) });
    return;
  }
  segs.push({ ...base, nodes });
}

/** Joins sections that meet at a node used by nothing else and continue the same road. */
function mergeSections(segs, keep) {
  let alive = segs.map((s, i) => ({ ...s, key: i }));
  const incident = new Map();
  const add = (id, s) => {
    if (!incident.has(id)) incident.set(id, new Set());
    incident.get(id).add(s);
  };
  const remove = (id, s) => incident.get(id) && incident.get(id).delete(s);
  alive.forEach((s) => { add(s.nodes[0], s); add(s.nodes[s.nodes.length - 1], s); });
  const dead = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, set] of incident) {
      if (set.size !== 2 || keep.has(id)) continue;
      let [a, b] = [...set];
      if (a === b || !sameRoad(a, b)) continue;
      const aEnd = a.nodes[a.nodes.length - 1];
      const bStart = b.nodes[0];
      if (a.oneway) {
        if (aEnd === id && bStart === id) { /* a then b */ }
        else if (b.nodes[b.nodes.length - 1] === id && a.nodes[0] === id) { [a, b] = [b, a]; }
        else continue;
      }
      let an = a.nodes;
      let bn = b.nodes;
      if (an[an.length - 1] !== id) an = an.slice().reverse();
      if (bn[0] !== id) bn = bn.slice().reverse();
      if (an[0] === bn[bn.length - 1]) continue; // would make a loop
      const merged = { ...a, nodes: an.concat(bn.slice(1)) };
      remove(a.nodes[0], a); remove(a.nodes[a.nodes.length - 1], a);
      remove(b.nodes[0], b); remove(b.nodes[b.nodes.length - 1], b);
      dead.add(a); dead.add(b);
      add(merged.nodes[0], merged); add(merged.nodes[merged.nodes.length - 1], merged);
      alive.push(merged);
      changed = true;
    }
  }
  return alive.filter((s) => !dead.has(s));
}

/** Largest strongly connected part of the directed road graph (Tarjan, iterative). */
function largestStronglyConnected(segs) {
  const out = new Map();
  const link = (a, b) => {
    if (!out.has(a)) out.set(a, []);
    if (!out.has(b)) out.set(b, []);
    out.get(a).push(b);
  };
  for (const s of segs) {
    const a = s.nodes[0];
    const b = s.nodes[s.nodes.length - 1];
    link(a, b);
    if (!s.oneway) link(b, a);
  }
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  let best = [];
  for (const root of out.keys()) {
    if (idx.has(root)) continue;
    const work = [[root, 0]];
    idx.set(root, index); low.set(root, index); index++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const nbrs = out.get(v);
      if (i < nbrs.length) {
        frame[1]++;
        const w = nbrs[i];
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > best.length) best = comp;
        }
      }
    }
  }
  return new Set(best);
}

// ---------- places ----------

function categoryOf(t) {
  if (t.amenity === "hospital") return "Hospitals";
  if (t.amenity === "clinic") return "Clinics";
  if (["school", "college", "university"].includes(t.amenity)) return "Schools and colleges";
  if (t.amenity === "marketplace" || t.shop === "mall") return "Markets and shopping";
  if (t.amenity === "bus_station" || t.railway === "station") return "Transport";
  if (t.place || t.boundary === "local_authority") return "Areas and junctions";
  if (t.amenity === "place_of_worship") return "Temples, mosques and churches";
  if (t.highway === "traffic_signals") return null;
  return "Other landmarks";
}

function readPlaces(placesJson, extra) {
  const out = [];
  const signals = new Set();
  const schools = [];
  const markets = [];
  for (const el of placesJson.elements) {
    const t = el.tags || {};
    const lat = el.lat !== undefined ? el.lat : el.center && el.center.lat;
    const lon = el.lon !== undefined ? el.lon : el.center && el.center.lon;
    if (lat === undefined) continue;
    if (t.highway === "traffic_signals" && el.type === "node") signals.add(el.id);
    const cat = categoryOf(t);
    // Hazard sources count even without a name.
    if (cat === "Schools and colleges") schools.push({ lat, lon });
    if (cat === "Markets and shopping") markets.push({ lat, lon });
    if (!cat || !t.name) continue;
    const place = { name: t.name.trim(), category: cat, lat, lon, osm: el.type + "/" + el.id };
    if (cat === "Hospitals") {
      place.kind = "hospital";
      // Eye and dental hospitals do not take accident emergencies.
      if (/\b(eye|dental|dentist)\b/i.test(t.name) || /^(ophthalmology|dentistry)$/.test(t["healthcare:speciality"] || "")) {
        place.emergency = false;
      }
    }
    out.push(place);
  }
  for (const p of extra || []) out.push({ category: "Areas and junctions", ...p });
  // The same place tagged twice (e.g. as a point and as a building).
  const unique = [];
  for (const p of out) {
    if (unique.some((q) => q.name === p.name && q.category === p.category && haversine(p, q) < 80)) continue;
    unique.push(p);
  }
  return { places: unique, signals, schools, markets };
}

/** Gives places that share a name a distinguishing label. */
function labelPlaces(places) {
  const areas = places.filter((p) => p.category === "Areas and junctions");
  const counts = {};
  places.forEach((p) => { counts[p.name] = (counts[p.name] || 0) + 1; });
  const used = new Set();
  for (const p of places) {
    let label = p.name;
    if (counts[p.name] > 1) {
      const near = areas.filter((a) => a !== p && a.name !== p.name)
        .sort((a, b) => haversine(p, a) - haversine(p, b))[0];
      if (near) label = p.name + " (near " + near.name + ")";
    }
    let n = 2;
    const base = label;
    while (used.has(label)) label = base + " #" + n++;
    used.add(label);
    p.label = label;
  }
}

// ---------- main build ----------

function buildNetwork(roadsJson, placesJson, area) {
  const { coords, ways } = readWays(roadsJson, area.bbox);
  const { places, signals, schools, markets } = readPlaces(placesJson, area.extraPlaces);
  const project = projector(area.center[0]);

  // Pass 1: road sections, joined where a road simply continues.
  let segs = mergeSections(splitWays(ways, signals), signals);
  const scc = largestStronglyConnected(segs);
  segs = segs.filter((s) => scc.has(s.nodes[0]) && scc.has(s.nodes[s.nodes.length - 1]));

  // Pass 2: snap each place to its nearest road point; split sections there.
  const roadPoints = [];
  const seen = new Set();
  for (const s of segs) for (const id of s.nodes) if (!seen.has(id)) { seen.add(id); roadPoints.push(id); }
  const pointXY = new Map(roadPoints.map((id) => [id, project(coords.get(id))]));
  const snapped = [];
  for (const p of places) {
    const xy = project(p);
    let bestId = null;
    let bestD = Infinity;
    for (const id of roadPoints) {
      const q = pointXY.get(id);
      const d = Math.hypot(q.x - xy.x, q.y - xy.y);
      if (d < bestD) { bestD = d; bestId = id; }
    }
    if (bestD <= area.snapMaxMetres) snapped.push({ place: p, road: bestId, metres: bestD });
  }
  const splitAt = new Set(snapped.map((s) => s.road));
  const split = [];
  for (const s of segs) {
    let start = 0;
    for (let i = 1; i < s.nodes.length; i++) {
      if (i === s.nodes.length - 1 || splitAt.has(s.nodes[i])) {
        split.push({ ...s, nodes: s.nodes.slice(start, i + 1) });
        start = i;
      }
    }
  }
  segs = split;

  // Busy junctions: traffic signals, or where two or more named main roads meet.
  const majorNames = new Map();
  for (const s of segs) {
    if (!MAJOR.has(s.type) || !s.name) continue;
    for (const id of [s.nodes[0], s.nodes[s.nodes.length - 1]]) {
      if (!majorNames.has(id)) majorNames.set(id, new Set());
      majorNames.get(id).add(s.name);
    }
  }
  const busy = (id) => signals.has(id) || (majorNames.has(id) && majorNames.get(id).size >= 2);

  const schoolXY = schools.map(project);
  const marketXY = markets.map(project);
  const near = (pts, sources, metres) => sources.some((src) => {
    for (let i = 1; i < pts.length; i++) if (pointSegmentDistance(src, pts[i - 1], pts[i]) <= metres) return true;
    return false;
  });

  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const roadNodeIds = new Set();
  const namesAt = new Map();
  const EDGES = [];
  segs.forEach((s, i) => {
    const pts = s.nodes.map((id) => coords.get(id));
    let metres = 0;
    for (let k = 1; k < pts.length; k++) metres += haversine(pts[k - 1], pts[k]);
    const xy = pts.map(project);
    const hazards = new Set(s.hazards);
    if (near(xy, schoolXY, area.schoolZoneMetres)) hazards.add("school");
    if (near(xy, marketXY, area.marketZoneMetres)) hazards.add("market");
    const a = s.nodes[0];
    const b = s.nodes[s.nodes.length - 1];
    if (MAJOR.has(s.type) && (busy(a) || busy(b))) hazards.add("junction");
    const edge = {
      id: "r" + i,
      from: "n" + a,
      to: "n" + b,
      name: s.name || "Unnamed " + ROAD_TYPES[s.type].label.toLowerCase(),
      corridor: s.name,
      type: s.type,
      distanceKm: Math.max(1, Math.round(metres)) / 1000,
      hazards: HAZARD_ORDER.filter((h) => hazards.has(h)),
      geom: pts.flatMap((p) => [r5(p.lat), r5(p.lon)])
    };
    if (s.oneway) edge.oneway = true;
    if (s.speed) edge.freeFlowKmh = s.speed;
    EDGES.push(edge);
    for (const id of [a, b]) {
      roadNodeIds.add(id);
      if (s.name) {
        if (!namesAt.has(id)) namesAt.set(id, new Set());
        namesAt.get(id).add(s.name);
      }
    }
  });

  const NODES = [...roadNodeIds].sort((x, y) => x - y).map((id) => {
    const c = coords.get(id);
    const names = [...(namesAt.get(id) || [])].sort();
    const name = names.length >= 2 ? names.slice(0, 2).join(" / ") + " junction"
      : names.length === 1 ? "Point on " + names[0] : "Unnamed junction";
    return { id: "n" + id, name, lat: r5(c.lat), lon: r5(c.lon) };
  });

  // Places, each joined to its road point by an access path.
  labelPlaces(snapped.map((s) => s.place));
  snapped.sort((a, b) => a.place.label.localeCompare(b.place.label));
  snapped.forEach((s, i) => {
    const p = s.place;
    const node = { id: "p" + i, name: p.label, lat: r5(p.lat), lon: r5(p.lon), category: p.category, osm: p.osm };
    if (p.kind) node.kind = p.kind;
    if (p.emergency === false) node.emergency = false;
    NODES.push(node);
    const road = coords.get(s.road);
    EDGES.push({
      id: "a" + i,
      from: node.id,
      to: "n" + s.road,
      name: "Access to " + p.label,
      corridor: "",
      type: "access",
      distanceKm: Math.max(5, Math.round(s.metres)) / 1000,
      hazards: [],
      geom: [r5(p.lat), r5(p.lon), r5(road.lat), r5(road.lon)]
    });
  });

  const byLabel = (label) => {
    const n = NODES.find((x) => x.category && (x.name === label || x.name.startsWith(label + " (")));
    return n ? n.id : null;
  };

  return {
    AREA: { name: area.areaName, bbox: area.bbox, center: area.center, zoom: area.zoom },
    ATTRIBUTION: "Map data © OpenStreetMap contributors (ODbL)",
    UNITS: { distancePerKm: 1000, timePerMin: 60 },
    ROAD_TYPES,
    CONGESTION_LEVELS: DEMO.CONGESTION_LEVELS,
    CONGESTION_ORDER: DEMO.CONGESTION_ORDER,
    BASE_RISK: 1,
    HAZARDS,
    HAZARD_ORDER,
    DAY_START_HOUR: 6,
    DAY_END_HOUR: 22,
    TIME_BANDS,
    SCENARIOS: [],
    PLACE_CATEGORIES,
    NODES,
    EDGES,
    DEFAULTS: {
      origin: byLabel(area.defaultOrigin),
      destination: byLabel(area.defaultDestination),
      scenarioId: null,
      hour: 12,
      priority: "fastest"
    }
  };
}

module.exports = { buildNetwork, haversine };

if (require.main === module) {
  const ROOT = path.resolve(__dirname, "..");
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", "osm", f), "utf8"));
  let roads, places, meta;
  try {
    roads = read("roads.json");
    places = read("places.json");
    meta = read("meta.json");
  } catch {
    console.error("No map download found in data/osm/. Run: npm run fetch-map");
    process.exit(1);
  }
  const data = buildNetwork(roads, places, AREA);
  data.GENERATED = { downloaded: meta.downloaded, built: new Date().toISOString() };
  const body =
    "/*\n * GENERATED by scripts/build-real-network.js from OpenStreetMap data. Do not edit by hand:\n" +
    " * change scripts/real-area.config.js, then run npm run fetch-map and npm run build-map.\n" +
    " * Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).\n" +
    " * Works in the browser (exposes window.RealTrafficData) and in Node (module.exports).\n */\n" +
    "(function (root, data) {\n" +
    '  if (typeof module === "object" && module.exports) module.exports = data;\n' +
    "  else root.RealTrafficData = data;\n" +
    '})(typeof self !== "undefined" ? self : this, ' + JSON.stringify(data) + ");\n";
  const out = path.join(ROOT, "js", "real-network-data.js");
  fs.writeFileSync(out, body);
  const places_ = data.NODES.filter((n) => n.category);
  console.log(
    `Built ${path.relative(ROOT, out)} (${(Buffer.byteLength(body) / 1024).toFixed(0)} KB): ` +
    `${data.NODES.length - places_.length} junctions, ${data.EDGES.length} road sections, ${places_.length} places ` +
    `(${places_.filter((p) => p.kind === "hospital").length} hospitals). Default route: ${data.DEFAULTS.origin} -> ${data.DEFAULTS.destination}`
  );
}
