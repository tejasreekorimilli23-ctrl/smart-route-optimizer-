/*
 * Turn-by-turn directions for a route from RouteEngine.
 *
 * 1. The route's road sections are laid end to end in travel order, with
 *    their real shapes (real map) or straight lines between places (demo).
 * 2. Consecutive sections on the same road form one "leg". Very short legs
 *    (under 25 m, or unnamed lanes under 60 m, e.g. a bit of side lane at a
 *    junction) are folded into the next leg, so they do not produce a
 *    pointless instruction.
 * 3. At each change of road, the turn is classified from the change in
 *    compass direction between the last 30 m before the junction and the
 *    first 30 m after it:
 *        under 25°  straight on        25-60°  slight left/right
 *        60-145°    left/right         over 145°  U-turn
 * 4. Each step says what to do, onto which road, and how far to follow it.
 *
 * Steps contain no text; the app words them in the page language.
 * Works in the browser (exposes window.Directions) and in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Directions = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SETTINGS = {
    minLegMetres: 25, // shorter legs are folded into the next one
    minUnnamedLegMetres: 60, // ...and so are unnamed lanes shorter than this
    bearingSampleMetres: 30,
    straightMax: 25,
    slightMax: 60,
    turnMax: 145
  };
  var R = 6371008.8;
  var COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

  function rad(d) { return (d * Math.PI) / 180; }
  function deg(r) { return (r * 180) / Math.PI; }

  function dist(a, b) {
    var dLat = rad(b.lat - a.lat);
    var dLon = rad(b.lon - a.lon);
    var h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Compass bearing from a to b, 0 = north, clockwise, in degrees. */
  function bearing(a, b) {
    var y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    var x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  /** Signed change from bearing a to bearing b, in -180..180 (positive = right). */
  function turnAngle(a, b) {
    var d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  function classify(angle) {
    var a = Math.abs(angle);
    var side = angle > 0 ? "right" : "left";
    if (a < SETTINGS.straightMax) return "straight";
    if (a < SETTINGS.slightMax) return "slight-" + side;
    if (a < SETTINGS.turnMax) return side;
    return "uturn";
  }

  function compass(b) {
    return COMPASS[Math.round(b / 45) % 8];
  }

  /**
   * Points of an edge in travel direction. Real map edges have geom
   * [lat, lon, ...]; demo edges are straight lines between nodes whose x/y
   * (y pointing down) are turned into small pseudo-coordinates.
   */
  function edgePoints(edge, fromId, nodeById) {
    var pts = [];
    if (edge.geom) {
      for (var i = 0; i < edge.geom.length; i += 2) pts.push({ lat: edge.geom[i], lon: edge.geom[i + 1] });
    } else {
      [edge.from, edge.to].forEach(function (id) {
        var n = nodeById[id];
        pts.push(n.lat !== undefined ? { lat: n.lat, lon: n.lon } : { lat: -n.y / 10000, lon: n.x / 10000 });
      });
    }
    if (edge.from !== fromId) pts.reverse();
    return pts;
  }

  /** Bearing over roughly the first (or, reversed, last) `metres` of a polyline. */
  function headBearing(pts, metres, fromEnd) {
    var list = fromEnd ? pts.slice().reverse() : pts;
    var walked = 0;
    var end = list[list.length - 1];
    for (var i = 1; i < list.length; i++) {
      walked += dist(list[i - 1], list[i]);
      if (walked >= metres) { end = list[i]; break; }
    }
    var b = bearing(list[0], end);
    return fromEnd ? (b + 180) % 360 : b;
  }

  /**
   * route: a RouteEngine route (nodes, edges, segments).
   * edgeById / nodeById: lookups for the data the route was found on.
   * Returns [{ kind: "depart" | "turn" | "arrive", turn, road, roadEdgeId,
   *            metres, point: {lat, lon}, compass, units }] where units are the
   * route's distance units for the leg (for display with the app's formatter).
   */
  function build(route, edgeById, nodeById) {
    // Legs: consecutive non-access sections with the same road name.
    var legs = [];
    route.segments.forEach(function (s, i) {
      var e = edgeById[s.edgeId];
      if (!e || e.type === "access") return;
      var pts = edgePoints(e, route.nodes[i], nodeById);
      var metres = 0;
      for (var k = 1; k < pts.length; k++) metres += dist(pts[k - 1], pts[k]);
      var key = e.corridor !== undefined ? e.corridor || "~" + e.type : e.name;
      var last = legs[legs.length - 1];
      if (last && last.key === key) {
        last.pts = last.pts.concat(pts.slice(1));
        last.metres += metres;
        last.units += s.distanceUnits;
        return;
      }
      legs.push({ key: key, named: key.charAt(0) !== "~", edgeId: e.id, pts: pts, metres: metres, units: s.distanceUnits });
    });
    if (!legs.length) return [];

    // Fold very short legs into the next one (keeping the longer leg's name).
    var merged = [];
    legs.forEach(function (leg, i) {
      var tooShort = leg.metres < SETTINGS.minLegMetres || (!leg.named && leg.metres < SETTINGS.minUnnamedLegMetres);
      if (tooShort && i < legs.length - 1) {
        var next = legs[i + 1];
        next.pts = leg.pts.concat(next.pts.slice(1));
        next.metres += leg.metres;
        next.units += leg.units;
        return;
      }
      var prev = merged[merged.length - 1];
      if (prev && prev.key === leg.key) {
        prev.pts = prev.pts.concat(leg.pts.slice(1));
        prev.metres += leg.metres;
        prev.units += leg.units;
        return;
      }
      merged.push(leg);
    });

    var steps = [];
    merged.forEach(function (leg, i) {
      if (i === 0) {
        steps.push({
          kind: "depart", turn: null, roadEdgeId: leg.edgeId, metres: leg.metres, units: leg.units,
          point: leg.pts[0], compass: compass(headBearing(leg.pts, SETTINGS.bearingSampleMetres, false))
        });
        return;
      }
      var before = headBearing(merged[i - 1].pts, SETTINGS.bearingSampleMetres, true);
      var after = headBearing(leg.pts, SETTINGS.bearingSampleMetres, false);
      steps.push({
        kind: "turn", turn: classify(turnAngle(before, after)), roadEdgeId: leg.edgeId,
        metres: leg.metres, units: leg.units, point: leg.pts[0], compass: compass(after)
      });
    });
    var lastLeg = merged[merged.length - 1];
    steps.push({ kind: "arrive", turn: null, roadEdgeId: null, metres: 0, units: 0, point: lastLeg.pts[lastLeg.pts.length - 1], compass: null });
    return steps;
  }

  return {
    SETTINGS: SETTINGS,
    build: build,
    bearing: bearing,
    turnAngle: turnAngle,
    classify: classify,
    distance: dist
  };
});
