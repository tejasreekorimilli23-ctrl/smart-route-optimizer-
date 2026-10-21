/*
 * Long-distance routes (between towns), calculated by a routing service.
 *
 * The app's own Dijkstra works on the road network of ONE downloaded area
 * (at most about 12 x 12 km): a phone cannot download and hold the road
 * network between two cities. For trips longer than that, the route itself
 * comes from a routing service:
 *
 *  - TomTom Routing API (Calculate Route), when the user has saved a TomTom
 *    key: uses live and historic traffic, gives up to 2 alternatives.
 *  - Otherwise the free OpenStreetMap routing service of FOSSGIS
 *    (routing.openstreetmap.de, OSRM): no key, no traffic (typical speeds
 *    from OpenStreetMap), car and foot profiles.
 *
 * What stays the app's own work: choosing among the candidate routes by the
 * user's objective (fastest / shortest / safest), the vehicle speed caps
 * (auto 35 km/h, two-wheeler 50 km/h, as on the local map) and a LIMITED
 * risk score: 1 point per km plus 2 per km on national highways (the local
 * model's "highway with heavy vehicles" weight). Schools, markets, junctions
 * and other hazards are only known inside a downloaded area, so this score
 * is a rough comparison, not a safety rating.
 *
 * Exposes window.LongRoute; also works in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LongRoute = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SETTINGS = {
    timeoutMs: 25000,
    tomtomAlternatives: 2,
    highwayRiskPerKm: 2, // same weight as the local map's "highway with heavy vehicles"
    baseRiskPerKm: 1
  };

  var OSM_BASE = "https://routing.openstreetmap.de/";
  var TOMTOM_BASE = "https://api.tomtom.com/routing/1/calculateRoute/";

  // The local map's vehicle profiles (js/route-engine.js): speed caps.
  var CAPS = { car: null, auto: 35, twowheeler: 50, walk: null };

  var MESSAGES = {
    nofetch: "This browser cannot reach the routing service.",
    badpoint: "The start or destination is not a valid position.",
    same: "Start and destination are the same place.",
    noroute: "The routing service found no road route between these places.",
    denied: "TomTom refused the key for routing (check that the Routing API is enabled for it).",
    limit: "The routing service's request limit was reached. Try again later.",
    timeout: "The routing service did not answer in time.",
    failed: "The routing service did not answer. Check the internet connection and try again."
  };

  function failure(code, provider) {
    var err = new Error(MESSAGES[code] || code);
    err.code = code;
    err.provider = provider || null;
    return err;
  }

  function validPoint(p) {
    return p && isFinite(p.lat) && isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
  }

  function withTimeout(promise, ms, provider) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(failure("timeout", provider)); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  function getJson(doFetch, url, provider) {
    var req;
    try {
      req = Promise.resolve(doFetch(url));
    } catch (err) {
      req = Promise.reject(err);
    }
    return withTimeout(req, SETTINGS.timeoutMs, provider).then(function (res) {
      if (res.status === 401 || res.status === 403) throw failure("denied", provider);
      if (res.status === 429) throw failure("limit", provider);
      if (res.status === 400) throw failure("noroute", provider); // TomTom: no road connection / point too far from a road
      if (!res.ok) throw failure("failed", provider);
      return res.json().catch(function () { throw failure("failed", provider); });
    }, function (err) {
      throw err && err.code ? err : failure("failed", provider);
    });
  }

  function isHighway(road) {
    return /(^|[^A-Z])NH\s?\d|National Highway/i.test(road || "");
  }

  var COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  function compassOf(bearing) {
    return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
  }

  /** OSRM modifier -> the app's turn classes (js/directions.js). */
  function turnOf(modifier) {
    switch (modifier) {
      case "left": case "sharp left": return "left";
      case "right": case "sharp right": return "right";
      case "slight left": return "slight-left";
      case "slight right": return "slight-right";
      case "uturn": return "uturn";
      default: return "straight";
    }
  }

  /** TomTom maneuver code -> turn class. */
  function turnOfCode(code) {
    code = String(code || "");
    if (/UTURN/.test(code)) return "uturn";
    if (/(KEEP|BEAR)_LEFT/.test(code)) return "slight-left";
    if (/(KEEP|BEAR)_RIGHT/.test(code)) return "slight-right";
    if (/LEFT/.test(code)) return "left";
    if (/RIGHT/.test(code)) return "right";
    return "straight";
  }

  /**
   * Common route shape:
   * { distanceM, durationS (for the vehicle), serviceDurationS, noTrafficS,
   *   delayS, coords: [[lat, lon], ...], steps: [{ kind, turn, compass, road, distanceM }],
   *   roads: [names in order], highwayM, riskUnits (metre-points) }
   */
  function finish(route, vehicle) {
    var cap = CAPS[vehicle] || null;
    var duration = 0;
    var highwayM = 0;
    route.parts.forEach(function (p) {
      var s = p.durationS;
      if (cap && p.distanceM > 0 && s > 0) {
        var kmh = (p.distanceM / 1000) / (s / 3600);
        if (kmh > cap) s = (p.distanceM / 1000) / cap * 3600;
      }
      duration += s;
      if (isHighway(p.road)) highwayM += p.distanceM;
    });
    // If the parts do not add up (rounding), keep the service's total for a car.
    if (!cap) duration = route.serviceDurationS;
    route.durationS = Math.round(duration);
    route.highwayM = Math.round(highwayM);
    route.riskUnits = Math.round(route.distanceM * SETTINGS.baseRiskPerKm + highwayM * SETTINGS.highwayRiskPerKm);
    var seen = {};
    route.roads = route.steps.map(function (s) { return s.road; }).filter(function (r) {
      if (!r || seen[r]) return false;
      seen[r] = true;
      return true;
    });
    delete route.parts;
    return route;
  }

  // ---------- OpenStreetMap routing (FOSSGIS OSRM) ----------

  function osmUrl(from, to, vehicle) {
    var profile = vehicle === "walk" ? "routed-foot" : "routed-car";
    return OSM_BASE + profile + "/route/v1/driving/" +
      from.lon.toFixed(6) + "," + from.lat.toFixed(6) + ";" + to.lon.toFixed(6) + "," + to.lat.toFixed(6) +
      "?overview=full&geometries=geojson&alternatives=true&steps=true";
  }

  function fromOsrm(json, vehicle) {
    if (!json || json.code === "NoRoute" || !Array.isArray(json.routes) || !json.routes.length) throw failure("noroute", "osm");
    if (json.code !== "Ok") throw failure("failed", "osm");
    return json.routes.map(function (r) {
      var steps = [];
      var parts = [];
      ((r.legs && r.legs[0] && r.legs[0].steps) || []).forEach(function (s) {
        var road = s.ref ? (s.name ? s.name + " (" + s.ref + ")" : s.ref) : (s.name || "");
        var m = s.maneuver || {};
        parts.push({ distanceM: s.distance || 0, durationS: s.duration || 0, road: s.ref || s.name || "" });
        if (m.type === "arrive") {
          steps.push({ kind: "arrive", road: road, distanceM: 0 });
          return;
        }
        var kind = m.type === "depart" ? "depart" : "turn";
        var prev = steps[steps.length - 1];
        // "Continue on the same road" steps are joined into the previous one.
        if (prev && kind === "turn" && (m.type === "new name" || m.type === "continue") && turnOf(m.modifier) === "straight" && prev.road === road) {
          prev.distanceM += s.distance || 0;
          return;
        }
        steps.push({ kind: kind, turn: turnOf(m.modifier), compass: compassOf(m.bearing_after || 0), road: road, distanceM: s.distance || 0 });
      });
      var coords = ((r.geometry && r.geometry.coordinates) || []).map(function (c) { return [c[1], c[0]]; });
      return finish({
        distanceM: Math.round(r.distance),
        serviceDurationS: Math.round(r.duration),
        noTrafficS: null,
        delayS: null,
        coords: coords,
        steps: steps,
        parts: parts
      }, vehicle);
    });
  }

  // ---------- TomTom Routing API ----------

  var TOMTOM_MODE = { car: "car", auto: "car", twowheeler: "motorcycle", walk: "pedestrian" };

  /** Local date-time with its UTC offset, as TomTom's departAt wants it (2026-10-22T08:30:00+05:30). */
  function isoLocal(d) {
    var pad = function (n) { return String(Math.abs(n)).padStart(2, "0"); };
    var off = -d.getTimezoneOffset();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":00" +
      (off >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60);
  }

  /** opts: { avoidTolls, departAt (Date, used when in the future) } */
  function tomtomUrl(from, to, vehicle, key, opts) {
    opts = opts || {};
    var later = opts.departAt instanceof Date && opts.departAt.getTime() > Date.now() + 60000;
    return TOMTOM_BASE + from.lat.toFixed(6) + "," + from.lon.toFixed(6) + ":" + to.lat.toFixed(6) + "," + to.lon.toFixed(6) +
      "/json?key=" + encodeURIComponent(key) +
      "&traffic=true&routeType=fastest&travelMode=" + (TOMTOM_MODE[vehicle] || "car") +
      "&maxAlternatives=" + SETTINGS.tomtomAlternatives +
      "&computeTravelTimeFor=all&instructionsType=coded&language=en-GB" +
      (opts.avoidTolls ? "&avoid=tollRoads" : "") +
      (later ? "&departAt=" + encodeURIComponent(isoLocal(opts.departAt)) : "");
  }

  function fromTomtom(json, vehicle) {
    if (!json || !Array.isArray(json.routes) || !json.routes.length) throw failure("noroute", "tomtom");
    return json.routes.map(function (r) {
      var sum = r.summary || {};
      var coords = [];
      (r.legs || []).forEach(function (leg) {
        (leg.points || []).forEach(function (p) { coords.push([p.latitude, p.longitude]); });
      });
      var ins = (r.guidance && r.guidance.instructions) || [];
      var steps = [];
      var parts = [];
      ins.forEach(function (it, i) {
        var next = ins[i + 1];
        var dist = next ? Math.max(0, (next.routeOffsetInMeters || 0) - (it.routeOffsetInMeters || 0)) : 0;
        var dur = next ? Math.max(0, (next.travelTimeInSeconds || 0) - (it.travelTimeInSeconds || 0)) : 0;
        var num = (it.roadNumbers && it.roadNumbers.length) ? it.roadNumbers.join("/") : "";
        var road = it.street ? (num ? it.street + " (" + num + ")" : it.street) : num;
        parts.push({ distanceM: dist, durationS: dur, road: num || it.street || "" });
        var code = it.maneuver || "";
        if (/ARRIVE/.test(code)) steps.push({ kind: "arrive", road: road, distanceM: 0 });
        else steps.push({ kind: /DEPART/.test(code) ? "depart" : "turn", turn: turnOfCode(code), compass: "north", road: road, distanceM: dist });
      });
      var noTraffic = sum.noTrafficTravelTimeInSeconds;
      return finish({
        distanceM: Math.round(sum.lengthInMeters || 0),
        serviceDurationS: Math.round(sum.travelTimeInSeconds || 0),
        noTrafficS: isFinite(noTraffic) ? Math.round(noTraffic) : null,
        delayS: isFinite(sum.trafficDelayInSeconds) ? Math.round(sum.trafficDelayInSeconds) : null,
        coords: coords,
        steps: steps,
        parts: parts.length ? parts : [{ distanceM: sum.lengthInMeters || 0, durationS: sum.travelTimeInSeconds || 0, road: "" }]
      }, vehicle);
    });
  }

  // ---------- choosing ----------

  var COST = { fastest: "durationS", shortest: "distanceM", safest: "riskUnits" };

  /**
   * Orders candidate routes for the objective; marks the best for each
   * objective. Ties: quicker, then shorter.
   */
  function rank(routes, priority) {
    var key = COST[priority] || "durationS";
    var sorted = routes.slice().sort(function (a, b) {
      return a[key] - b[key] || a.durationS - b.durationS || a.distanceM - b.distanceM;
    });
    Object.keys(COST).forEach(function (p) {
      var k = COST[p];
      var best = routes.slice().sort(function (a, b) { return a[k] - b[k] || a.durationS - b.durationS; })[0];
      routes.forEach(function (r) { r["is" + p.charAt(0).toUpperCase() + p.slice(1)] = r === best; });
    });
    return sorted;
  }

  /**
   * Plans a long route. opts: { from, to, vehicle, priority, tomtomKey }.
   * Resolves to { provider: "tomtom"|"osm", traffic: "live"|"none",
   * fetchedAt, routes (best first), fellBack: error that made TomTom fall
   * back to OpenStreetMap routing, or null }. Rejects with err.code.
   */
  function plan(opts, fetchImpl) {
    var doFetch = fetchImpl || (typeof fetch === "function" ? function (u) { return fetch(u); } : null);
    if (!doFetch) return Promise.reject(failure("nofetch"));
    var from = opts.from;
    var to = opts.to;
    if (!validPoint(from) || !validPoint(to)) return Promise.reject(failure("badpoint"));
    if (Math.abs(from.lat - to.lat) < 1e-5 && Math.abs(from.lon - to.lon) < 1e-5) return Promise.reject(failure("same"));
    var vehicle = CAPS.hasOwnProperty(opts.vehicle) ? opts.vehicle : "car";
    var priority = COST[opts.priority] ? opts.priority : "fastest";

    var viaOsm = function (fellBack) {
      return getJson(doFetch, osmUrl(from, to, vehicle), "osm").then(function (json) {
        var routes = rank(fromOsrm(json, vehicle), priority);
        return {
          provider: "osm", traffic: "none", fetchedAt: new Date(), routes: routes, fellBack: fellBack || null, vehicle: vehicle, priority: priority,
          tollsNotAvoided: !!opts.avoidTolls, departAtUsed: false
        };
      });
    };
    if (!opts.tomtomKey) return viaOsm(null);
    var later = opts.departAt instanceof Date && opts.departAt.getTime() > Date.now() + 60000;
    return getJson(doFetch, tomtomUrl(from, to, vehicle, opts.tomtomKey, opts), "tomtom").then(function (json) {
      var routes = rank(fromTomtom(json, vehicle), priority);
      return {
        provider: "tomtom", traffic: later ? "predicted" : "live", fetchedAt: new Date(), routes: routes, fellBack: null, vehicle: vehicle, priority: priority,
        tollsNotAvoided: false, departAtUsed: later
      };
    }, function (err) {
      // TomTom failed (wrong key, limit, no answer): say so, and use the free OpenStreetMap routing instead.
      if (err.code === "noroute") throw err;
      return viaOsm(err);
    });
  }

  return {
    SETTINGS: SETTINGS,
    MESSAGES: MESSAGES,
    plan: plan,
    rank: rank,
    fromOsrm: fromOsrm,
    fromTomtom: fromTomtom,
    osmUrl: osmUrl,
    tomtomUrl: tomtomUrl,
    isoLocal: isoLocal,
    isHighway: isHighway
  };
});
