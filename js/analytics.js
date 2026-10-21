/*
 * Trip analytics: numbers for the dashboard under the routes.
 *
 *  - baseline(): the route a traffic-UNAWARE planner would pick (best by
 *    free-flow time, ignoring traffic, incidents and closures), and how it
 *    performs under today's conditions. "Time saved" is measured against it.
 *  - byHour(): the recommended route's estimated time for each departure
 *    hour (time-of-day estimates only, never live data).
 *  - reliability(): how much the trip time varies over the day (and over
 *    the user's own recorded trips, when there are enough).
 *  - eco(): fuel and CO2 estimate with a simple documented model.
 *  - reportCsv(): a trip comparison report to download.
 *
 * Works in the browser (window.TripAnalytics) and in Node (tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TripAnalytics = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /*
   * Fuel model (planning estimate, typical Indian figures, not measured):
   *   litres = distance_km / km_per_litre + idle_litres_per_hour x delay_hours
   *   CO2 kg = litres x 2.31 (petrol; IPCC emission factor ~2.3 kg CO2 per litre)
   * Delay = time lost to traffic compared with free-flow; while crawling, an
   * engine burns roughly its idle consumption.
   */
  var ECO = {
    car: { kmPerLitre: 15, idleLitresPerHour: 0.8 },
    auto: { kmPerLitre: 25, idleLitresPerHour: 0.5 },
    twowheeler: { kmPerLitre: 45, idleLitresPerHour: 0.25 },
    walk: { kmPerLitre: 0, idleLitresPerHour: 0 },
    co2PerLitre: 2.31
  };

  function eco(distanceKm, delayHours, vehicle) {
    var v = ECO[vehicle] || ECO.car;
    if (!v.kmPerLitre) return { litres: 0, co2Kg: 0 };
    var litres = distanceKm / v.kmPerLitre + v.idleLitresPerHour * Math.max(0, delayHours);
    return { litres: Math.round(litres * 100) / 100, co2Kg: Math.round(litres * ECO.co2PerLitre * 100) / 100 };
  }

  /** Levels with every road "light": what a planner without traffic data assumes. */
  function freeLevels(data) {
    var out = {};
    data.EDGES.forEach(function (e) { out[e.id] = "light"; });
    return out;
  }

  /**
   * The traffic-unaware choice and its cost today.
   * Returns { route: {edges, timeUnits (free-flow)}, nowTimeUnits, blocked,
   * savedUnits } or null. savedUnits = baseline today - recommended today
   * (0 when the recommendation is the same route).
   */
  function baseline(E, data, levels, origin, destination, vehicle, recommended) {
    var res = E.findRoutes(data, freeLevels(data), origin, destination, { priority: "fastest", vehicle: vehicle });
    if (!res.ok) return null;
    var naive = res.recommended;
    var now = E.evaluatePath(data, levels, naive.edges, { vehicle: vehicle });
    var same = recommended && naive.signature === recommended.signature;
    return {
      route: naive,
      freeUnits: naive.timeUnits,
      nowTimeUnits: now.closed ? null : now.timeUnits,
      blocked: !!now.closed,
      same: !!same,
      savedUnits: now.closed || !recommended ? null : Math.max(0, now.timeUnits - recommended.timeUnits)
    };
  }

  /**
   * Best (fastest) time for each departure hour, from the time-of-day
   * estimates. extra(levels) may add today's closures and reports on top.
   * Returns [{ hour, timeUnits | null }].
   */
  function byHour(E, data, origin, destination, vehicle, extra) {
    var out = [];
    for (var h = data.DAY_START_HOUR; h <= data.DAY_END_HOUR; h++) {
      var levels = E.levelsForHour(data, h);
      if (!levels) continue;
      if (extra) levels = extra(levels);
      var graph = E.buildGraph(data, levels, "fastest", vehicle);
      var p = E.dijkstra(graph, origin, destination);
      out.push({ hour: h, timeUnits: p ? p.timeUnits : null });
    }
    return out;
  }

  /**
   * Reliability from the spread of times: over the day's estimates, and over
   * the user's own recorded trips when there are at least 3.
   * Returns { key: "high"|"medium"|"low", spreadPct, min, max, source }.
   */
  function reliability(hourly, trips) {
    var times = (trips && trips.length >= 3 ? trips : hourly.map(function (x) { return x.timeUnits; })).filter(function (x) { return x > 0; });
    if (times.length < 2) return null;
    var min = Math.min.apply(null, times);
    var max = Math.max.apply(null, times);
    var spread = Math.round(((max - min) / min) * 100);
    return { key: spread <= 20 ? "high" : spread <= 50 ? "medium" : "low", spreadPct: spread, min: min, max: max, source: trips && trips.length >= 3 ? "trips" : "estimates" };
  }

  /** Median of a list of numbers (null for an empty list). */
  function median(list) {
    if (!list.length) return null;
    var s = list.slice().sort(function (a, b) { return a - b; });
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }

  /** Share of a route's length in each traffic level, in percent (adds up to 100). */
  function distribution(levelDistanceUnits) {
    var total = (levelDistanceUnits.light || 0) + (levelDistanceUnits.moderate || 0) + (levelDistanceUnits.heavy || 0);
    if (!total) return { light: 0, moderate: 0, heavy: 0 };
    var m = Math.round(((levelDistanceUnits.moderate || 0) / total) * 100);
    var h = Math.round(((levelDistanceUnits.heavy || 0) / total) * 100);
    return { light: 100 - m - h, moderate: m, heavy: h };
  }

  function csvCell(v) {
    var s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** rows: array of arrays -> CSV text (with a byte-order mark so Excel reads Telugu). */
  function toCsv(rows) {
    return "﻿" + rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
  }

  return {
    ECO: ECO,
    eco: eco,
    freeLevels: freeLevels,
    baseline: baseline,
    byHour: byHour,
    reliability: reliability,
    median: median,
    distribution: distribution,
    toCsv: toCsv
  };
});
