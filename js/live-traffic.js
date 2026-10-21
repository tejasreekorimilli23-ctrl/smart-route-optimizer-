/*
 * Live traffic from TomTom (Traffic Flow API, "flowSegmentData").
 *
 * For a set of sample points along the main roads, TomTom returns the
 * current speed and the free-flow speed of the road segment there, plus that
 * segment's shape. Each answer is turned into a traffic level:
 *     current / free-flow >= 0.8  -> light
 *     current / free-flow >= 0.5  -> moderate
 *     below that                  -> heavy;   road closed -> closed
 * and applied to every main-road section of our map that lies along the
 * returned shape. Roads without a live answer keep the time-of-day estimate.
 *
 * The API key is the user's own (free at developer.tomtom.com). It is kept
 * only in that browser, never in the code. Each update uses one request per
 * sample point (at most 80), well inside the free daily allowance.
 *
 * Works in the browser (exposes window.LiveTraffic) and in Node (for tests;
 * pass a fetch function).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LiveTraffic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ENDPOINT = "https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json";
  var MAIN_TYPES = {
    motorway: 1, motorway_link: 1, trunk: 1, trunk_link: 1, primary: 1, primary_link: 1,
    secondary: 1, secondary_link: 1, tertiary: 1, tertiary_link: 1
  };
  var SETTINGS = {
    spacingMetres: 600, // at most one sample point per road within this distance
    maxPoints: 80, // requests per update (TomTom free tier: 2,500 a day)
    matchMetres: 20, // a road section matches if its middle is this close to TomTom's shape
    parallel: 6, // requests at a time
    lightMinRatio: 0.8,
    moderateMinRatio: 0.5
  };
  var R = 6371008.8;

  function rad(d) {
    return (d * Math.PI) / 180;
  }

  function flatXY(lat0) {
    var kx = (Math.PI / 180) * R * Math.cos(rad(lat0));
    var ky = (Math.PI / 180) * R;
    return function (p) { return { x: p.lon * kx, y: p.lat * ky }; };
  }

  function midpoint(geom) {
    var i = Math.floor(geom.length / 4) * 2;
    return { lat: geom[i], lon: geom[i + 1] };
  }

  function isMain(edge) {
    return !!MAIN_TYPES[edge.type] && !!edge.geom;
  }

  /**
   * Sample points along the main roads: walks the main-road sections in a
   * fixed order and keeps a point when no point on the same road is within
   * spacingMetres. Busier road types come first, so they are covered even
   * if maxPoints is reached.
   */
  function samplePoints(data) {
    var order = ["motorway", "trunk", "primary", "secondary", "tertiary"];
    var rank = function (t) {
      var base = t.replace("_link", "");
      var i = order.indexOf(base);
      return (i < 0 ? 9 : i) * 2 + (t.indexOf("_link") >= 0 ? 1 : 0);
    };
    var edges = data.EDGES.filter(isMain).sort(function (a, b) {
      return rank(a.type) - rank(b.type) || (a.id < b.id ? -1 : 1);
    });
    var xy = flatXY(data.AREA ? data.AREA.center[0] : 0);
    var points = [];
    for (var i = 0; i < edges.length && points.length < SETTINGS.maxPoints; i++) {
      var e = edges[i];
      var m = midpoint(e.geom);
      var p = xy(m);
      var road = e.corridor || "unnamed " + e.type;
      var close = points.some(function (q) {
        return q.road === road && Math.hypot(q.x - p.x, q.y - p.y) < SETTINGS.spacingMetres;
      });
      if (!close) points.push({ lat: m.lat, lon: m.lon, x: p.x, y: p.y, road: road, edgeId: e.id });
    }
    return points;
  }

  function levelFor(seg) {
    if (seg.roadClosure) return "closed";
    if (!(seg.freeFlowSpeed > 0) || !(seg.currentSpeed >= 0)) return null;
    var r = seg.currentSpeed / seg.freeFlowSpeed;
    if (r >= SETTINGS.lightMinRatio) return "light";
    if (r >= SETTINGS.moderateMinRatio) return "moderate";
    return "heavy";
  }

  function distanceToLine(p, pts) {
    var best = Infinity;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1];
      var b = pts[i];
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    if (pts.length === 1) best = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
    return best;
  }

  /**
   * Turns TomTom answers into { edgeId: level } for the main-road sections
   * along each answer's shape. When two answers cover a section, the more
   * congested level wins.
   */
  function matchToEdges(data, answers) {
    var xy = flatXY(data.AREA ? data.AREA.center[0] : 0);
    var severity = { light: 0, moderate: 1, heavy: 2, closed: 3 };
    var mains = data.EDGES.filter(isMain).map(function (e) {
      return { id: e.id, mid: xy(midpoint(e.geom)) };
    });
    var levels = {};
    answers.forEach(function (ans) {
      var level = levelFor(ans);
      var coords = ans.coordinates && ans.coordinates.coordinate;
      if (!level || !coords || !coords.length) return;
      var line = coords.map(function (c) { return xy({ lat: c.latitude, lon: c.longitude }); });
      mains.forEach(function (m) {
        if (distanceToLine(m.mid, line) > SETTINGS.matchMetres) return;
        if (!levels[m.id] || severity[level] > severity[levels[m.id]]) levels[m.id] = level;
      });
    });
    return levels;
  }

  var MESSAGES = {
    nofetch: "This browser cannot fetch live traffic.",
    nokey: "Enter a TomTom API key first.",
    denied: "TomTom refused the key. Check that it is correct and that the Traffic API is enabled for it.",
    limit: "TomTom's request limit was reached. Try again later.",
    noanswer: "No live traffic came back. Check the internet connection and try again."
  };

  /** An Error with a .code the app can translate (see MESSAGES). */
  function failure(code) {
    var err = new Error(MESSAGES[code]);
    err.code = code;
    return err;
  }

  /**
   * Fetches live traffic for the data's main roads.
   * Resolves to { levels, roads, points, answered, fetchedAt } or rejects
   * with an Error whose .code is one of MESSAGES.
   */
  function fetchLive(data, key, fetchImpl) {
    var doFetch = fetchImpl || (typeof fetch === "function" ? function (url) { return fetch(url); } : null);
    if (!doFetch) return Promise.reject(failure("nofetch"));
    if (!key || !/^[A-Za-z0-9_-]{10,}$/.test(key)) return Promise.reject(failure("nokey"));
    var points = samplePoints(data);
    var answers = [];
    var fatal = null;
    var next = 0;

    function one(p) {
      var url = ENDPOINT + "?point=" + p.lat.toFixed(5) + "," + p.lon.toFixed(5) + "&unit=KMPH&key=" + encodeURIComponent(key);
      var request;
      try {
        request = Promise.resolve(doFetch(url));
      } catch (err) {
        request = Promise.reject(err); // some browsers throw at once for blocked requests
      }
      return request.then(function (res) {
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) fatal = "denied";
          else if (res.status === 429) fatal = "limit";
          return null;
        }
        return res.json().then(function (json) {
          if (json && json.flowSegmentData) answers.push(json.flowSegmentData);
        });
      }).catch(function () { return null; });
    }

    function worker() {
      if (fatal || next >= points.length) return Promise.resolve();
      var p = points[next++];
      return one(p).then(worker);
    }

    var workers = [];
    for (var i = 0; i < SETTINGS.parallel; i++) workers.push(worker());
    return Promise.all(workers).then(function () {
      if (fatal) throw failure(fatal);
      if (!answers.length) throw failure("noanswer");
      var levels = matchToEdges(data, answers);
      return {
        levels: levels,
        roads: Object.keys(levels).length,
        points: points.length,
        answered: answers.length,
        fetchedAt: new Date()
      };
    });
  }

  /** Raster tile URL for TomTom's live traffic overlay on the map. */
  function overlayUrl(key) {
    return "https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?tileSize=256&key=" + encodeURIComponent(key);
  }

  return {
    SETTINGS: SETTINGS,
    MESSAGES: MESSAGES,
    samplePoints: samplePoints,
    levelFor: levelFor,
    matchToEdges: matchToEdges,
    fetchLive: fetchLive,
    overlayUrl: overlayUrl
  };
});
