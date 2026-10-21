/*
 * Trip mode logic: where am I on the route, what is next, am I off route,
 * and how fast did I actually travel on each road (for shared speeds).
 * No drawing and no GPS here: the app feeds in positions.
 *
 * Works in the browser (exposes window.Trip) and in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Trip = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SETTINGS = {
    offRouteMetres: 50, // further than this from the route counts as off route...
    offRouteFixes: 2, // ...for this many positions in a row
    arriveMetres: 30, // this close to the end = arrived
    stepPassedMetres: 10, // a turn counts as passed this far after it
    announceMetres: [200, 50], // spoken reminders before a turn
    minEdgeSeconds: 5, // shorter passes are too noisy to measure speed
    minEdgeMetres: 60, // and so are very short road sections
    maxKmh: 120
  };
  var R = 6371008.8;

  function rad(d) { return (d * Math.PI) / 180; }

  function dist(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * The route as one polyline: points with the distance along the route
   * (metres), the road section they belong to, and the route time units
   * spent up to that point (each section's time spread evenly over it).
   */
  function line(route, edgeById) {
    var pts = [];
    var along = 0;
    var time = 0;
    var edges = [];
    route.edges.forEach(function (eid, i) {
      var e = edgeById[eid];
      var seg = route.segments[i];
      var g = [];
      for (var k = 0; k < e.geom.length; k += 2) g.push({ lat: e.geom[k], lon: e.geom[k + 1] });
      if (e.from !== route.nodes[i]) g.reverse();
      var len = 0;
      for (k = 1; k < g.length; k++) len += dist(g[k - 1], g[k]);
      var start = along;
      var startTime = time;
      var walked = 0;
      g.forEach(function (p, k2) {
        if (k2 > 0) walked += dist(g[k2 - 1], p);
        if (k2 === 0 && pts.length) return; // shared with the previous section's last point
        pts.push({ lat: p.lat, lon: p.lon, along: start + walked, time: startTime + (len ? (walked / len) * seg.timeUnits : 0), edgeId: eid });
      });
      along += len;
      time += seg.timeUnits;
      edges.push({ id: eid, start: start, end: along, metres: len, type: e.type });
    });
    return { pts: pts, length: along, timeUnits: time, edges: edges };
  }

  /** Nearest point of the route to p: { along, offset, edgeId, time }. */
  function locate(ln, p) {
    var kx = (Math.PI / 180) * R * Math.cos(rad(p.lat));
    var ky = (Math.PI / 180) * R;
    var best = null;
    for (var i = 1; i < ln.pts.length; i++) {
      var a = ln.pts[i - 1];
      var b = ln.pts[i];
      var ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
      var bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
      var dx = bx - ax, dy = by - ay;
      var l2 = dx * dx + dy * dy;
      var t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      var cx = ax + t * dx, cy = ay + t * dy;
      var d = Math.sqrt(cx * cx + cy * cy);
      if (!best || d < best.offset) {
        best = {
          offset: d,
          along: a.along + t * (b.along - a.along),
          time: a.time + t * (b.time - a.time),
          edgeId: b.edgeId
        };
      }
    }
    return best;
  }

  /** Distance along the route of each step's turn point. */
  function stepAlongs(ln, steps) {
    return steps.map(function (s, i) {
      if (i === 0) return 0;
      if (s.kind === "arrive") return ln.length;
      return locate(ln, s.point).along;
    });
  }

  /**
   * Where the traveller is: the next step, distance to it, what is left,
   * and whether they have arrived. `at` comes from locate().
   */
  function status(ln, alongs, at) {
    var next = alongs.length - 1;
    for (var i = 1; i < alongs.length; i++) {
      if (alongs[i] > at.along + SETTINGS.stepPassedMetres) { next = i; break; }
    }
    var remaining = Math.max(0, ln.length - at.along);
    return {
      nextIndex: next,
      toNextMetres: Math.max(0, alongs[next] - at.along),
      remainingMetres: remaining,
      remainingUnits: Math.max(0, Math.round(ln.timeUnits - at.time)),
      arrived: remaining <= SETTINGS.arriveMetres
    };
  }

  /** Counts positions in a row that are off the route. */
  function offRouteCounter() {
    var count = 0;
    return function (at) {
      count = at && at.offset <= SETTINGS.offRouteMetres ? 0 : count + 1;
      return count >= SETTINGS.offRouteFixes;
    };
  }

  /**
   * Measures the real speed on each road section passed from end to end.
   * feed(at, timeMs) returns { edgeId, kmh } when a section was completed.
   */
  function speedTracker(ln) {
    var byId = {};
    ln.edges.forEach(function (e) { byId[e.id] = e; });
    var current = null; // { id, enteredAt, enteredAlong }
    return function (at, timeMs) {
      if (!at) return null;
      var out = null;
      if (current && at.edgeId !== current.id) {
        var e = byId[current.id];
        var seconds = (timeMs - current.enteredAt) / 1000;
        var fromStart = current.enteredAlong - e.start <= 25;
        var toEnd = at.along >= e.end - 5;
        var measurable = e.type !== "access" && e.metres >= SETTINGS.minEdgeMetres;
        if (measurable && fromStart && toEnd && seconds >= SETTINGS.minEdgeSeconds) {
          var kmh = (e.metres / 1000) / (seconds / 3600);
          if (kmh <= SETTINGS.maxKmh) out = { edgeId: e.id, kmh: Math.round(kmh * 10) / 10 };
        }
      }
      if (!current || at.edgeId !== current.id) current = { id: at.edgeId, enteredAt: timeMs, enteredAlong: at.along };
      return out;
    };
  }

  /** Which spoken reminder (if any) is due for this distance to the next turn. */
  function reminderDue(toNextMetres, alreadySaid) {
    for (var i = 0; i < SETTINGS.announceMetres.length; i++) {
      var m = SETTINGS.announceMetres[i];
      if (toNextMetres <= m && alreadySaid.indexOf(m) < 0) return m;
    }
    return null;
  }

  return {
    SETTINGS: SETTINGS,
    line: line,
    locate: locate,
    stepAlongs: stepAlongs,
    status: status,
    offRouteCounter: offRouteCounter,
    speedTracker: speedTracker,
    reminderDue: reminderDue,
    distance: dist
  };
});
