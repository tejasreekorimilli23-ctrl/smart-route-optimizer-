/*
 * Geographic helpers for the real map:
 *  - pin a GPS position or a map click to the nearest road, as a temporary
 *    location joined to both ends of that road section (one-way rules kept);
 *  - mark road sections near accident black spots.
 * Works in the browser (exposes window.GeoTools) and in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GeoTools = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var R = 6371008.8;
  var MAX_PIN_METRES = 400; // further than this from any road counts as outside the map

  function rad(d) {
    return (d * Math.PI) / 180;
  }

  function haversine(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var h = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function points(geom) {
    var out = [];
    for (var i = 0; i < geom.length; i += 2) out.push({ lat: geom[i], lon: geom[i + 1] });
    return out;
  }

  /**
   * Closest point on a polyline to p. Returns { metres (offset from the line),
   * along (metres from the start), total (line length), index (segment),
   * point }. Uses a flat projection around p, fine over a few km.
   */
  function projectOnLine(pts, p) {
    var kx = (Math.PI / 180) * R * Math.cos(rad(p.lat));
    var ky = (Math.PI / 180) * R;
    var xy = function (q) { return { x: (q.lon - p.lon) * kx, y: (q.lat - p.lat) * ky }; };
    var best = { metres: Infinity };
    var walked = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = xy(pts[i - 1]);
      var b = xy(pts[i]);
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var t = len ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / (len * len))) : 0;
      var cx = a.x + t * dx;
      var cy = a.y + t * dy;
      var d = Math.sqrt(cx * cx + cy * cy);
      if (d < best.metres) {
        best = {
          metres: d,
          along: walked + t * len,
          index: i - 1,
          point: { lat: p.lat + cy / ky, lon: p.lon + cx / kx }
        };
      }
      walked += len;
    }
    best.total = walked;
    return best;
  }

  /** The road section closest to (lat, lon), ignoring access paths. */
  function nearestRoad(data, lat, lon) {
    var p = { lat: lat, lon: lon };
    var best = null;
    data.EDGES.forEach(function (e) {
      if (!e.geom || e.type === "access") return;
      // Cheap bounding check first: skip sections clearly further than the best.
      var g = e.geom;
      if (best) {
        var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
        for (var i = 0; i < g.length; i += 2) {
          if (g[i] < minLat) minLat = g[i];
          if (g[i] > maxLat) maxLat = g[i];
          if (g[i + 1] < minLon) minLon = g[i + 1];
          if (g[i + 1] > maxLon) maxLon = g[i + 1];
        }
        var margin = best.metres / 111000 + 1e-4;
        if (lat < minLat - margin || lat > maxLat + margin || lon < minLon - margin * 1.1 || lon > maxLon + margin * 1.1) return;
      }
      var hit = projectOnLine(points(g), p);
      if (!best || hit.metres < best.metres) {
        hit.edge = e;
        best = hit;
      }
    });
    return best;
  }

  function flat(pts) {
    var out = [];
    pts.forEach(function (q) { out.push(Math.round(q.lat * 1e5) / 1e5, Math.round(q.lon * 1e5) / 1e5); });
    return out;
  }

  /**
   * A temporary location at (lat, lon), joined to both ends of the nearest
   * road section. Returns { node, edges } to add to the data, or null if the
   * point is too far from every road.
   */
  function pinToRoad(data, id, name, lat, lon) {
    var hit = nearestRoad(data, lat, lon);
    if (!hit || hit.metres > MAX_PIN_METRES) return null;
    var e = hit.edge;
    var pts = points(e.geom);
    var node = { id: id, name: name, lat: lat, lon: lon, pinned: true };
    var toStart = pts.slice(0, hit.index + 1).concat([hit.point]); // from e.from to the pin's road point
    var toEnd = [hit.point].concat(pts.slice(hit.index + 1)); // from the pin's road point to e.to
    var pin = { lat: lat, lon: lon };
    var km = function (m) { return Math.max(1, Math.round(m)) / 1000; };
    var base = {
      name: e.name, corridor: e.corridor, type: e.type, hazards: e.hazards || [], parentId: e.id
    };
    if (e.freeFlowKmh) base.freeFlowKmh = e.freeFlowKmh;
    var a = Object.assign({}, base, {
      id: id + "-a", from: e.from, to: id,
      distanceKm: km(hit.along + hit.metres), geom: flat(toStart.concat([pin]))
    });
    var b = Object.assign({}, base, {
      id: id + "-b", from: id, to: e.to,
      distanceKm: km(hit.total - hit.along + hit.metres), geom: flat([pin].concat(toEnd))
    });
    if (e.oneway) {
      a.oneway = true;
      b.oneway = true;
    }
    return { node: node, edges: [a, b], offsetMetres: hit.metres, road: e };
  }

  /**
   * Adds the "blackspot" hazard to every road section that passes within a
   * black spot's radius. Changes data.EDGES in place; returns how many
   * sections were marked.
   */
  function applyBlackspots(data, spots) {
    var marked = 0;
    (spots || []).forEach(function (s) {
      if (typeof s.lat !== "number" || typeof s.lon !== "number") return;
      var radius = s.radiusMetres || 100;
      data.EDGES.forEach(function (e) {
        if (!e.geom || (e.hazards || []).indexOf("blackspot") >= 0) return;
        if (projectOnLine(points(e.geom), s).metres <= radius) {
          e.hazards = ["blackspot"].concat(e.hazards || []);
          marked++;
        }
      });
    });
    return marked;
  }

  return {
    MAX_PIN_METRES: MAX_PIN_METRES,
    haversine: haversine,
    nearestRoad: nearestRoad,
    pinToRoad: pinToRoad,
    applyBlackspots: applyBlackspots
  };
});
