/*
 * Loads the real road network of any town, in the browser.
 *
 *  1. find(query): looks the place up with OpenStreetMap's search
 *     (Nominatim). Only called when the user presses Search.
 *  2. boxForResult / boxInfo: picks the area to download: the place's own
 *     outline if it is town-sized, else a square of about 8 km around it (a
 *     whole city is too big for a phone: boxInfo says when that happened).
 *     boxAround covers a whole trip (both ends) up to maxAreaKm2.
 *  3. load(name, box): downloads the roads and the places from the Overpass
 *     API at the same time (with backup servers if one is busy), builds the
 *     network with js/osm-network.js exactly like the built-in Vizianagaram
 *     map, and checks it (enough roads, a connected network).
 *  4. session(): makes sure only the newest load is used. A slower, older
 *     download that finishes later is ignored instead of replacing the area
 *     the user chose since.
 *  5. Areas are kept in the browser's IndexedDB, so a town opens instantly
 *     next time and works offline.
 *
 * Map data © OpenStreetMap contributors (ODbL). The public servers are free
 * but shared: the app only calls them when the user asks for a new area.
 *
 * Exposes window.AreaLoader. Pure helpers also work in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./osm-network.js"));
  } else {
    root.AreaLoader = factory(root.OsmNetwork);
  }
})(typeof self !== "undefined" ? self : this, function (OSM) {
  "use strict";

  var SEARCH = "https://nominatim.openstreetmap.org/search";
  // Public Overpass servers, tried in turn; they are free and often busy.
  var OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];
  var SETTINGS = {
    squareKm: 8, // area loaded around a single point
    maxSpanKm: 25, // largest area (both directions) the app will load
    maxAreaKm2: 150, // ...and at most this many square km (about 12 x 12 km): more is too slow for phones
    minSpanKm: 4, // a small place's outline is widened to at least this
    marginKm: 1.5, // extra around two places loaded together
    keepAreas: 4, // areas remembered in the browser
    // Order of attempts: the main server recovers quickly when busy, the
    // backups are tried in between. [server index, seconds to wait first]
    attempts: [[0, 0], [0, 5], [1, 0], [0, 15], [2, 0], [0, 30]],
    timeoutSeconds: 75, // a request taking longer than this is abandoned
    limitPauseSeconds: 20 // after "too many requests" (HTTP 429), wait at least this long
  };
  var KM_LAT = 110.574;

  function kmLon(lat) {
    return 111.32 * Math.cos((lat * Math.PI) / 180);
  }

  function round(v) {
    return Math.round(v * 10000) / 10000;
  }

  /** Box [south, west, north, east] of halfKm around a point. */
  function square(lat, lon, halfKm) {
    var dLat = halfKm / KM_LAT;
    var dLon = halfKm / kmLon(lat);
    return [round(lat - dLat), round(lon - dLon), round(lat + dLat), round(lon + dLon)];
  }

  function spanKm(box) {
    var mid = (box[0] + box[2]) / 2;
    return { ns: (box[2] - box[0]) * KM_LAT, ew: (box[3] - box[1]) * kmLon(mid) };
  }

  function areaKm2(box) {
    var s = spanKm(box);
    return s.ns * s.ew;
  }

  function fits(box) {
    var s = spanKm(box);
    return s.ns <= SETTINGS.maxSpanKm && s.ew <= SETTINGS.maxSpanKm && s.ns * s.ew <= SETTINGS.maxAreaKm2;
  }

  /**
   * The area to load for a search result: its own outline when that is
   * between minSpanKm and maxSpanKm, else a square of squareKm around it.
   */
  function boxForResult(r) {
    if (r.box) {
      var s = spanKm(r.box);
      if (fits(r.box) && (s.ns >= SETTINGS.minSpanKm || s.ew >= SETTINGS.minSpanKm)) {
        return r.box.map(round);
      }
    }
    return square(r.lat, r.lon, SETTINGS.squareKm / 2);
  }

  /**
   * boxForResult plus what it means for the user: cropped is true when the
   * place (e.g. a city) is bigger than the app can load, so only the part
   * around its centre is covered; full is the place's own size in km.
   */
  function boxInfo(r) {
    var box = boxForResult(r);
    var full = r.box ? spanKm(r.box) : null;
    return { box: box, cropped: !!full && !fits(r.box) && areaKm2(r.box) > areaKm2(box), full: full, span: spanKm(box) };
  }

  /**
   * One box covering two points with a margin, or null if they are too far
   * apart to load together.
   */
  function boxAround(a, b) {
    var lat0 = Math.min(a.lat, b.lat);
    var lat1 = Math.max(a.lat, b.lat);
    var lon0 = Math.min(a.lon, b.lon);
    var lon1 = Math.max(a.lon, b.lon);
    var mLat = SETTINGS.marginKm / KM_LAT;
    var mLon = SETTINGS.marginKm / kmLon((lat0 + lat1) / 2);
    var box = [round(lat0 - mLat), round(lon0 - mLon), round(lat1 + mLat), round(lon1 + mLon)];
    var s = spanKm(box);
    if (s.ns > SETTINGS.maxSpanKm || s.ew > SETTINGS.maxSpanKm) return null;
    // Make it at least a few km wide so the start or end is not on the edge.
    var c = { lat: (box[0] + box[2]) / 2, lon: (box[1] + box[3]) / 2 };
    var min = square(c.lat, c.lon, SETTINGS.minSpanKm / 2);
    var out = [Math.min(box[0], min[0]), Math.min(box[1], min[1]), Math.max(box[2], min[2]), Math.max(box[3], min[3])];
    return fits(out) ? out : null;
  }

  /** Straight-line distance in km between two points. */
  function distanceKm(a, b) {
    var dLat = (b.lat - a.lat) * KM_LAT;
    var dLon = (b.lon - a.lon) * kmLon((a.lat + b.lat) / 2);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  /**
   * Keeps track of area loads so only the newest one is used:
   * var t = s.begin(); ... later: if (!s.isCurrent(t)) ignore the result.
   */
  function session() {
    var current = 0;
    var busy = false;
    return {
      begin: function () { busy = true; return ++current; },
      isCurrent: function (token) { return token === current; },
      end: function (token) { if (token === current) busy = false; },
      busy: function () { return busy; },
      cancel: function () { current++; busy = false; }
    };
  }

  function contains(box, p) {
    return p.lat >= box[0] && p.lat <= box[2] && p.lon >= box[1] && p.lon <= box[3];
  }

  function failure(code) {
    var err = new Error("Area loader: " + code);
    err.code = code;
    return err;
  }

  function getFetch(fetchImpl) {
    return fetchImpl || (typeof fetch === "function" ? function (u, o) { return fetch(u, o); } : null);
  }

  /** Nominatim answer -> [{ name, label, lat, lon, box }]. */
  function parseSearch(rows) {
    return (rows || []).map(function (r) {
      var bb = r.boundingbox ? r.boundingbox.map(Number) : null; // south, north, west, east
      return {
        name: r.name || String(r.display_name || "").split(",")[0],
        label: r.display_name || r.name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        box: bb ? [bb[0], bb[2], bb[1], bb[3]] : null
      };
    }).filter(function (r) { return isFinite(r.lat) && isFinite(r.lon); });
  }

  /** Name of the town or locality at a point (OpenStreetMap reverse search), or null. */
  function whereIs(lat, lon, fetchImpl) {
    var doFetch = getFetch(fetchImpl);
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=en&lat=" +
      encodeURIComponent(lat) + "&lon=" + encodeURIComponent(lon);
    return Promise.resolve().then(function () { return doFetch(url); }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (j) {
      if (!j) return null;
      var a = j.address || {};
      return a.suburb || a.neighbourhood || a.village || a.town || a.city || a.county || j.name || null;
    }).catch(function () { return null; });
  }

  var PHOTON = "https://photon.komoot.io/api/";
  var INDIA_BOX = "68.1,6.5,97.5,37.1"; // west,south,east,north for Photon

  /** One Nominatim search. */
  function nominatim(query, opts, doFetch) {
    var url = SEARCH + "?format=jsonv2&limit=6&q=" + encodeURIComponent(query) +
      (opts.countryCodes ? "&countrycodes=" + encodeURIComponent(opts.countryCodes) : "") +
      "&accept-language=" + encodeURIComponent(opts.language || "en");
    return Promise.resolve().then(function () { return doFetch(url); }).then(function (res) {
      if (!res.ok) throw failure(res.status === 429 ? "busy" : "search");
      return res.json();
    }, function () {
      throw failure("offline");
    }).then(parseSearch);
  }

  /**
   * Spelling people use that OpenStreetMap names often write differently:
   * "and" -> "&" ("Lendi Institute of Engineering and Technology" is mapped
   * as "... Engineering & Technology"). Returns the query unchanged if
   * there is nothing to change.
   */
  function altQuery(query) {
    return String(query).replace(/\s+and\s+/gi, " & ").replace(/\s+/g, " ").trim();
  }

  /** Photon (komoot) answer -> the same shape as parseSearch. */
  function parsePhoton(json) {
    return ((json && json.features) || []).map(function (f) {
      var p = f.properties || {};
      var c = (f.geometry && f.geometry.coordinates) || [];
      var parts = [];
      [p.name, p.street && (p.housenumber ? p.housenumber + " " + p.street : p.street), p.district, p.city, p.county, p.state, p.postcode, p.country]
        .forEach(function (x) { if (x && parts.indexOf(x) < 0) parts.push(String(x)); });
      var ex = p.extent; // [west, north, east, south]
      return {
        name: p.name || parts[0] || "",
        label: parts.join(", "),
        lat: Number(c[1]),
        lon: Number(c[0]),
        box: Array.isArray(ex) && ex.length === 4 ? [ex[3], ex[0], ex[1], ex[2]] : null,
        source: "photon"
      };
    }).filter(function (r) { return isFinite(r.lat) && isFinite(r.lon) && r.name; });
  }

  /** One Photon search (OpenStreetMap data, tolerant of spelling). */
  function photon(query, opts, doFetch) {
    var url = PHOTON + "?limit=6&lang=en&q=" + encodeURIComponent(query) +
      (opts.countryCodes === "in" ? "&bbox=" + INDIA_BOX : "");
    return Promise.resolve().then(function () { return doFetch(url); }).then(function (res) {
      if (!res.ok) throw failure(res.status === 429 ? "busy" : "search");
      return res.json();
    }, function () {
      throw failure("offline");
    }).then(parsePhoton);
  }

  /**
   * Looks a place or address up. countryCodes e.g. "in" to prefer India
   * (optional). Tries OpenStreetMap's Nominatim; if it finds nothing, the
   * same query with "&" for "and"; then Photon, which finds places with
   * slightly different spelling. All three use OpenStreetMap data.
   */
  function find(query, opts, fetchImpl) {
    var doFetch = getFetch(fetchImpl);
    opts = opts || {};
    return nominatim(query, opts, doFetch).then(function (rows) {
      if (rows.length) return rows;
      var alt = altQuery(query);
      return (alt !== query ? nominatim(alt, opts, doFetch) : Promise.resolve([])).then(function (rows2) {
        if (rows2.length) return rows2;
        return photon(query, opts, doFetch).catch(function () { return []; });
      });
    });
  }

  function wait(seconds) {
    return new Promise(function (resolve) { setTimeout(resolve, seconds * 1000); });
  }

  /** One request, abandoned after timeoutSeconds. */
  function post(url, query, doFetch, signal) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, SETTINGS.timeoutSeconds * 1000);
    // The user chose something else: stop this request, freeing the server slot.
    var stop = function () { if (controller) controller.abort(); };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop);
    }
    return Promise.resolve().then(function () {
      return doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: controller ? controller.signal : undefined
      });
    }).then(function (res) {
      if (res.status === 429) throw failure("limit"); // too many requests from this connection
      if (!res.ok) throw failure(res.status >= 500 ? "busy" : "download");
      return res.json();
    }).then(function (json) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", stop);
      return json;
    }, function (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", stop);
      if (signal && signal.aborted) throw failure("cancelled");
      throw err && err.code ? err : failure("busy");
    });
  }

  /**
   * Runs an Overpass query following SETTINGS.attempts.
   * retrying(seconds) is called before each wait.
   */
  function overpass(query, doFetch, retrying, signal) {
    var n = 0;
    var lastError = null;
    function attempt() {
      if (signal && signal.aborted) return Promise.reject(failure("cancelled"));
      if (n >= SETTINGS.attempts.length) return Promise.reject(lastError || failure("busy"));
      var step = SETTINGS.attempts[n++];
      var server = step[0];
      var pause = step[1];
      // "Too many requests": wait longer before asking again.
      if (lastError && lastError.code === "limit") pause = Math.max(pause, SETTINGS.limitPauseSeconds);
      var number = n;
      var go = function () {
        if (signal && signal.aborted) return Promise.reject(failure("cancelled"));
        if (number > 1 && retrying) retrying(-1, number);
        return post(OVERPASS[server], query, doFetch, signal).catch(function (err) {
          if (err.code === "cancelled") throw err;
          lastError = err;
          return attempt();
        });
      };
      if (!pause) return go();
      if (retrying) retrying(pause, number);
      return wait(pause).then(go);
    }
    return attempt();
  }

  /**
   * Downloads and builds the network for a box. progress(step, seconds) is
   * called with "roads", "places", "building", "validating", or "retry"
   * (servers busy, trying again in `seconds`). Resolves to the data set.
   * Roads and places are downloaded at the same time (two requests, the
   * number Overpass allows at once), which roughly halves the wait.
   */
  function load(name, box, progress, fetchImpl, signal) {
    var doFetch = getFetch(fetchImpl);
    var q = OSM.queries(box);
    var tell = progress || function () {};
    // seconds > 0: waiting before the next try; -1: trying again now (attempt number).
    var retrying = function (seconds, attempt) {
      if (seconds > 0) tell("retry", seconds);
      else tell("retrying", attempt + " / " + SETTINGS.attempts.length);
    };
    var center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    var roadsDone = false;
    var placesDone = false;
    tell("roads");
    var roadsReq = overpass(q.roads, doFetch, retrying, signal).then(function (r) {
      roadsDone = true;
      if (!placesDone) tell("places");
      return r;
    });
    var placesReq = overpass(q.places, doFetch, retrying, signal).then(function (p) {
      placesDone = true;
      return p;
    });
    // Let the page show each step before the (synchronous) work starts.
    var pause = function (step) {
      return function (v) { tell(step); return wait(0.05).then(function () { return v; }); };
    };
    return Promise.all([roadsReq, placesReq]).then(pause("building")).then(function (both) {
      var roads = both[0];
      var places = both[1];
      if (!roads || !Array.isArray(roads.elements) || !places || !Array.isArray(places.elements)) throw failure("download");
      return OSM.buildNetwork(roads, places, OSM.areaSettings(name, box, center));
    }).then(pause("validating")).then(function (data) {
      // Checks: enough roads, and most of them in one connected network.
      if (data.EDGES.length < 20) throw failure("noroads");
      var st = data.STATS || {};
      if (st.sectionsFound && st.sectionsKept / st.sectionsFound < 0.2) throw failure("disconnected");
      // Start from the named place nearest the centre.
      var best = null;
      data.NODES.forEach(function (n) {
        if (!n.category) return;
        var d = Math.pow(n.lat - center[0], 2) + Math.pow(n.lon - center[1], 2);
        if (!best || d < best.d) best = { id: n.id, d: d };
      });
      data.DEFAULTS.origin = best ? best.id : null;
      data.DEFAULTS.destination = null;
      data.GENERATED = { downloaded: new Date().toISOString(), built: new Date().toISOString() };
      data.AREA.key = box.join(",");
      return data;
    });
  }

  // ---------- remembering areas (IndexedDB) ----------

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") { reject(failure("nostore")); return; }
      var req = indexedDB.open("route-areas", 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("areas", { keyPath: "key" }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(failure("nostore")); };
    });
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction("areas", mode);
        var out = fn(t.objectStore("areas"));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(failure("nostore")); };
      });
    });
  }

  /** Saves an area; keeps only the most recent SETTINGS.keepAreas. */
  function remember(data) {
    var entry = { key: data.AREA.key, name: data.AREA.name, savedAt: Date.now(), data: data };
    return tx("readwrite", function (s) { return s.put(entry); }).then(function () {
      return list();
    }).then(function (all) {
      var extra = all.slice(SETTINGS.keepAreas);
      return Promise.all(extra.map(function (a) { return tx("readwrite", function (s) { return s.delete(a.key); }); }));
    }).catch(function () { /* storage full or blocked: the area still works this time */ });
  }

  /** Remembered areas, newest first: [{ key, name, savedAt }]. */
  function list() {
    return tx("readonly", function (s) { return s.getAll(); }).then(function (rows) {
      return (rows || []).map(function (r) { return { key: r.key, name: r.name, savedAt: r.savedAt }; })
        .sort(function (a, b) { return b.savedAt - a.savedAt; });
    }).catch(function () { return []; });
  }

  function recall(key) {
    return tx("readonly", function (s) { return s.get(key); }).then(function (row) {
      return row ? row.data : null;
    }).catch(function () { return null; });
  }

  return {
    SETTINGS: SETTINGS,
    square: square,
    spanKm: spanKm,
    areaKm2: areaKm2,
    distanceKm: distanceKm,
    boxForResult: boxForResult,
    boxInfo: boxInfo,
    boxAround: boxAround,
    session: session,
    contains: contains,
    parseSearch: parseSearch,
    parsePhoton: parsePhoton,
    altQuery: altQuery,
    find: find,
    whereIs: whereIs,
    load: load,
    remember: remember,
    list: list,
    recall: recall
  };
});
