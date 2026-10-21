/*
 * Loads the real road network of any town, in the browser.
 *
 *  1. find(query): looks the place up with OpenStreetMap's search
 *     (Nominatim). Only called when the user presses Search.
 *  2. boxAround(...): picks the area to download: the place's own outline if
 *     it is town-sized, else a square of about 8 km around it. Two places can
 *     be covered together if they are at most ~25 km apart.
 *  3. load(name, box): downloads the roads and places from the Overpass API
 *     (with a second server if the first is busy) and builds the network
 *     with js/osm-network.js, exactly like the built-in Vizianagaram map.
 *  4. Areas are kept in the browser's IndexedDB, so a town opens instantly
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
    minSpanKm: 4, // a small place's outline is widened to at least this
    marginKm: 1.5, // extra around two places loaded together
    keepAreas: 4, // areas remembered in the browser
    // Order of attempts: the main server recovers quickly when busy, the
    // backups are tried in between. [server index, seconds to wait first]
    attempts: [[0, 0], [0, 5], [1, 0], [0, 15], [2, 0], [0, 30]],
    timeoutSeconds: 75 // a request taking longer than this is abandoned
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

  /**
   * The area to load for a search result: its own outline when that is
   * between minSpanKm and maxSpanKm, else a square of squareKm around it.
   */
  function boxForResult(r) {
    if (r.box) {
      var s = spanKm(r.box);
      if (s.ns <= SETTINGS.maxSpanKm && s.ew <= SETTINGS.maxSpanKm && (s.ns >= SETTINGS.minSpanKm || s.ew >= SETTINGS.minSpanKm)) {
        return r.box.map(round);
      }
    }
    return square(r.lat, r.lon, SETTINGS.squareKm / 2);
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
    return [Math.min(box[0], min[0]), Math.min(box[1], min[1]), Math.max(box[2], min[2]), Math.max(box[3], min[3])];
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

  /** Looks a place up by name. countryCodes e.g. "in" to prefer India (optional). */
  function find(query, opts, fetchImpl) {
    var doFetch = getFetch(fetchImpl);
    opts = opts || {};
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

  function wait(seconds) {
    return new Promise(function (resolve) { setTimeout(resolve, seconds * 1000); });
  }

  /** One request, abandoned after timeoutSeconds. */
  function post(url, query, doFetch) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, SETTINGS.timeoutSeconds * 1000);
    return Promise.resolve().then(function () {
      return doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: controller ? controller.signal : undefined
      });
    }).then(function (res) {
      if (!res.ok) throw failure(res.status === 429 || res.status >= 500 || res.status === 504 ? "busy" : "download");
      return res.json();
    }).then(function (json) {
      clearTimeout(timer);
      return json;
    }, function (err) {
      clearTimeout(timer);
      throw err && err.code ? err : failure("busy");
    });
  }

  /**
   * Runs an Overpass query following SETTINGS.attempts.
   * retrying(seconds) is called before each wait.
   */
  function overpass(query, doFetch, retrying) {
    var n = 0;
    var lastError = null;
    function attempt() {
      if (n >= SETTINGS.attempts.length) return Promise.reject(lastError || failure("busy"));
      var step = SETTINGS.attempts[n++];
      var pause = step[1];
      var go = function () {
        return post(OVERPASS[step[0]], query, doFetch).catch(function (err) {
          lastError = err;
          return attempt();
        });
      };
      if (!pause) return go();
      if (retrying) retrying(pause);
      return wait(pause).then(go);
    }
    return attempt();
  }

  /**
   * Downloads and builds the network for a box. progress(step, seconds) is
   * called with "roads", "places", "building", or "retry" (servers busy,
   * trying again in `seconds`). Resolves to the data set.
   */
  function load(name, box, progress, fetchImpl) {
    var doFetch = getFetch(fetchImpl);
    var q = OSM.queries(box);
    var tell = progress || function () {};
    var retrying = function (seconds) { tell("retry", seconds); };
    var roads;
    tell("roads");
    return overpass(q.roads, doFetch, retrying).then(function (r) {
      roads = r;
      tell("places");
      return overpass(q.places, doFetch, retrying);
    }).then(function (places) {
      tell("building");
      var center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      var data = OSM.buildNetwork(roads, places, OSM.areaSettings(name, box, center));
      if (data.EDGES.length < 20) throw failure("noroads");
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
    boxForResult: boxForResult,
    boxAround: boxAround,
    contains: contains,
    parseSearch: parseSearch,
    find: find,
    load: load,
    remember: remember,
    list: list,
    recall: recall
  };
});
