/*
 * Long-distance (inter-city) trips: place search with spelling fallbacks
 * and routes from a routing service. Run with: npm test
 *
 * Two fixtures are REAL answers saved from the services (see their _note):
 *   tests/fixtures/osrm-vizag-lendi.json  OpenStreetMap routing (FOSSGIS OSRM)
 *   tests/fixtures/photon-lendi.json      Photon place search
 * The TomTom answers below are MOCKED from TomTom's documentation (no key
 * was available): they test the parsing and error handling only, not
 * TomTom's real service.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const LR = require("../js/long-route.js");
const A = require("../js/area-loader.js");
const OSRM = require("./fixtures/osrm-vizag-lendi.json");
const PHOTON = require("./fixtures/photon-lendi.json");

const VIZAG = { lat: 17.7231, lon: 83.3013, name: "My location" };
const LENDI = { lat: 18.02, lon: 83.4013, name: "Lendi Institute of Engineering & Technology" };

const json = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });

test("why the local map cannot do this trip: the two ends are too far apart for one area", () => {
  assert.ok(A.distanceKm(VIZAG, LENDI) > 30);
  assert.equal(A.boxAround(VIZAG, LENDI), null);
});

test("place search: 'and' is also tried as '&', the way OpenStreetMap names the college", async () => {
  assert.equal(A.altQuery("Lendi Institute of Engineering and Technology"), "Lendi Institute of Engineering & Technology");
  const asked = [];
  const fake = (url) => {
    asked.push(decodeURIComponent(url));
    if (url.includes("nominatim") && url.includes(encodeURIComponent("&"))) {
      return json([{ name: "Lendi Institute of Engineering & Technology", display_name: "Lendi Institute of Engineering & Technology, Vizianagaram Main Road", lat: "18.0200", lon: "83.4013", boundingbox: ["18.018", "18.022", "83.398", "83.404"] }]);
    }
    return json([]);
  };
  const rows = await A.find("Lendi Institute of Engineering and Technology", { countryCodes: "in" }, fake);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Lendi Institute of Engineering & Technology");
  assert.equal(asked.length, 2, "Photon is not needed when the second search finds it");
});

test("place search: Photon is tried when Nominatim finds nothing (real Photon answer)", async () => {
  const fake = (url) => (url.includes("photon") ? json(PHOTON) : json([]));
  const rows = await A.find("Lendi Institute of Engineering and Technology Jonnada Vizianagaram", { countryCodes: "in" }, fake);
  assert.ok(rows.length >= 1);
  assert.match(rows[0].label, /Lendi Institute of Engineering & Technology/);
  assert.match(rows[0].label, /Andhra Pradesh/, "a full address is shown to choose from");
  assert.ok(Math.abs(rows[0].lat - 18.02) < 0.01 && Math.abs(rows[0].lon - 83.4013) < 0.01);
});

test("real OpenStreetMap route Visakhapatnam -> Lendi is read correctly", () => {
  const r = LR.fromOsrm(OSRM, "car")[0];
  assert.ok(r.distanceM > 40000 && r.distanceM < 44000, r.distanceM + " m");
  assert.ok(r.durationS > 30 * 60 && r.durationS < 50 * 60, r.durationS + " s");
  assert.ok(r.coords.length > 500, "the full route line");
  const near = (a, p) => Math.abs(a[0] - p.lat) < 0.01 && Math.abs(a[1] - p.lon) < 0.01;
  assert.ok(near(r.coords[0], VIZAG) && near(r.coords[r.coords.length - 1], LENDI), "starts and ends at the two places");
  assert.equal(r.steps[0].kind, "depart");
  assert.equal(r.steps[r.steps.length - 1].kind, "arrive");
  assert.ok(r.roads.includes("NH16"), "follows NH16");
  assert.ok(r.highwayM > 20000, "most of it is on national highways");
  // Limited risk score: 1 point per km + 2 per km on national highways.
  assert.equal(r.riskUnits, Math.round(r.distanceM + 2 * r.highwayM));
});

test("vehicle speed caps make autos and two-wheelers slower than cars, as on the local map", () => {
  const car = LR.fromOsrm(OSRM, "car")[0];
  const auto = LR.fromOsrm(OSRM, "auto")[0];
  const bike = LR.fromOsrm(OSRM, "twowheeler")[0];
  assert.ok(auto.durationS > bike.durationS && bike.durationS > car.durationS);
  assert.ok(auto.durationS >= (auto.distanceM / 1000) / 35 * 3600 - 1, "never faster than 35 km/h on average");
});

test("candidates are ranked by the user's objective and each objective's best is marked", () => {
  const routes = [
    { durationS: 2400, distanceM: 42000, riskUnits: 110000 },
    { durationS: 2600, distanceM: 39000, riskUnits: 80000 },
    { durationS: 2500, distanceM: 45000, riskUnits: 60000 }
  ];
  assert.equal(LR.rank(routes, "fastest")[0], routes[0]);
  assert.equal(LR.rank(routes, "shortest")[0], routes[1]);
  assert.equal(LR.rank(routes, "safest")[0], routes[2]);
  assert.ok(routes[0].isFastest && routes[1].isShortest && routes[2].isSafest);
  assert.ok(!routes[0].isShortest && !routes[1].isSafest);
});

test("without a TomTom key, OpenStreetMap routing is asked, with the right profile and coordinate order", async () => {
  const urls = [];
  const fake = (url) => { urls.push(url); return json(OSRM); };
  const res = await LR.plan({ from: VIZAG, to: LENDI, vehicle: "car", priority: "fastest" }, fake);
  assert.equal(res.provider, "osm");
  assert.equal(res.traffic, "none", "no traffic data is claimed");
  assert.match(urls[0], /^https:\/\/routing\.openstreetmap\.de\/routed-car\/route\/v1\/driving\/83\.301300,17\.723100;83\.401300,18\.020000\?/);
  await LR.plan({ from: VIZAG, to: LENDI, vehicle: "walk" }, fake);
  assert.match(urls[1], /routed-foot/);
});

// ---------- TomTom (MOCKED answers, shaped like the documentation) ----------

const TOMTOM_OK = {
  routes: [
    {
      summary: { lengthInMeters: 43100, travelTimeInSeconds: 3900, trafficDelayInSeconds: 420, noTrafficTravelTimeInSeconds: 3300 },
      legs: [{ points: [{ latitude: 17.7231, longitude: 83.3013 }, { latitude: 17.9, longitude: 83.4 }, { latitude: 18.02, longitude: 83.4013 }] }],
      guidance: {
        instructions: [
          { routeOffsetInMeters: 0, travelTimeInSeconds: 0, maneuver: "DEPART", street: "Station Road" },
          { routeOffsetInMeters: 1500, travelTimeInSeconds: 300, maneuver: "TURN_RIGHT", roadNumbers: ["NH16"] },
          { routeOffsetInMeters: 40000, travelTimeInSeconds: 3600, maneuver: "KEEP_LEFT", roadNumbers: ["NH26"] },
          { routeOffsetInMeters: 43100, travelTimeInSeconds: 3900, maneuver: "ARRIVE" }
        ]
      }
    },
    {
      summary: { lengthInMeters: 47000, travelTimeInSeconds: 4100, trafficDelayInSeconds: 0, noTrafficTravelTimeInSeconds: 4100 },
      legs: [{ points: [{ latitude: 17.7231, longitude: 83.3013 }, { latitude: 18.02, longitude: 83.4013 }] }],
      guidance: { instructions: [{ routeOffsetInMeters: 0, travelTimeInSeconds: 0, maneuver: "DEPART", street: "Beach Road" }, { routeOffsetInMeters: 47000, travelTimeInSeconds: 4100, maneuver: "ARRIVE" }] }
    }
  ]
};

test("with a TomTom key: TomTom Calculate Route is asked, with traffic and the vehicle's travel mode (mocked)", async () => {
  const urls = [];
  const fake = (url) => { urls.push(url); return json(TOMTOM_OK); };
  const res = await LR.plan({ from: VIZAG, to: LENDI, vehicle: "twowheeler", priority: "fastest", tomtomKey: "TESTKEY1234567890" }, fake);
  assert.equal(res.provider, "tomtom");
  assert.equal(res.traffic, "live");
  const u = urls[0];
  assert.match(u, /^https:\/\/api\.tomtom\.com\/routing\/1\/calculateRoute\/17\.723100,83\.301300:18\.020000,83\.401300\/json\?/);
  assert.match(u, /traffic=true/);
  assert.match(u, /travelMode=motorcycle/);
  assert.match(u, /maxAlternatives=2/);
  assert.match(u, /computeTravelTimeFor=all/);
  const best = res.routes[0];
  assert.equal(best.distanceM, 43100);
  assert.equal(best.delayS, 420);
  assert.equal(best.steps[1].turn, "right");
  assert.equal(best.steps[2].turn, "slight-left");
  assert.equal(best.highwayM, 41600, "NH16 and NH26 stretches");
});

test("TomTom refuses the key: OpenStreetMap routing is used and the page is told why (mocked)", async () => {
  const fake = (url) => (url.includes("api.tomtom.com") ? json({}, 403) : json(OSRM));
  const res = await LR.plan({ from: VIZAG, to: LENDI, vehicle: "car", tomtomKey: "TESTKEY1234567890" }, fake);
  assert.equal(res.provider, "osm");
  assert.equal(res.fellBack.code, "denied");
});

test("clear errors: no road route, no answer, bad positions (mocked)", async () => {
  await assert.rejects(LR.plan({ from: VIZAG, to: LENDI }, () => json({ code: "NoRoute", routes: [] })), (e) => e.code === "noroute");
  await assert.rejects(LR.plan({ from: VIZAG, to: LENDI, tomtomKey: "TESTKEY1234567890" }, () => json({}, 400)), (e) => e.code === "noroute");
  await assert.rejects(LR.plan({ from: VIZAG, to: LENDI }, () => json({}, 503)), (e) => e.code === "failed");
  await assert.rejects(LR.plan({ from: VIZAG, to: LENDI }, () => { throw new TypeError("blocked"); }), (e) => e.code === "failed");
  await assert.rejects(LR.plan({ from: { lat: 200, lon: 0 }, to: LENDI }, () => json(OSRM)), (e) => e.code === "badpoint");
  await assert.rejects(LR.plan({ from: LENDI, to: LENDI }, () => json(OSRM)), (e) => e.code === "same");
  const saved = LR.SETTINGS.timeoutMs;
  LR.SETTINGS.timeoutMs = 30;
  try {
    await assert.rejects(LR.plan({ from: VIZAG, to: LENDI }, () => new Promise(() => {})), (e) => e.code === "timeout");
  } finally {
    LR.SETTINGS.timeoutMs = saved;
  }
});
