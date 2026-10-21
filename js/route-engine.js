/*
 * Route engine: deterministic route comparison over a weighted road graph.
 *
 * - Nodes are locations, edges are roads: two-way unless marked oneway,
 *   in which case they can only be driven from "from" to "to".
 * - Edge weight = estimated travel time under the current traffic:
 *       timeMin = (distanceKm / freeFlowKmh) * 60 * congestionFactor
 * - Each road also has a simulated safety risk:
 *       riskPoints = distanceKm * (BASE_RISK + sum of its hazard weights)
 * - The user picks a priority. "fastest" weights roads by time, "safest"
 *   by risk points. The best route for that weight comes from Dijkstra's
 *   algorithm.
 * - Alternatives come from Yen's k-shortest loopless paths (which calls
 *   Dijkstra repeatedly), followed by a small "distinctness" filter so the
 *   alternatives are not near-copies of each other.
 *
 * All times, distances and risk are kept as INTEGER UNITS set by the data's
 * UNITS (default: tenths of a minute and tenths of a kilometre, as in the
 * demo town; the real map uses seconds and metres). Risk units are distance
 * units times risk points per km. Each road's time is rounded once, and every
 * total, difference and percentage is computed from those integers, so the
 * totals always equal the sum of their roads exactly.
 *
 * No randomness: the same inputs always give the same output.
 *
 * Works in the browser (exposes window.RouteEngine) and in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RouteEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SETTINGS = {
    maxRoutes: 3, // routes shown to the user (1 recommended + up to 2 alternatives)
    candidatePool: 8, // k for Yen's algorithm before the distinctness filter
    yenMaxNodes: 500, // larger networks (real maps) use the faster penalty method for alternatives
    penaltyRounds: 6, // searches made by the penalty method
    penaltyFactor: 1.4, // each round, roads on the last route found cost this much more
    maxSharedLength: 0.75, // an alternative may share at most 75% of its length with a route already shown
    lightMaxRatio: 1.1, // journey time up to 10% over free-flow => "Light"
    moderateMaxRatio: 1.5, // up to 50% over free-flow => "Moderate", above => "Heavy"
    saferMaxRisk: 1.3, // average risk points per km up to this => "Safer route"
    cautionMaxRisk: 2.0 // up to this => "Some hazards", above => "Higher risk"
  };

  // What each priority minimises, and what breaks ties.
  var PRIORITIES = {
    fastest: { label: "Fastest", cost: "timeUnits", tie: "distanceUnits" },
    safest: { label: "Safest", cost: "riskUnits", tie: "timeUnits" }
  };

  function normalizePriority(priority) {
    return Object.prototype.hasOwnProperty.call(PRIORITIES, priority) ? priority : "fastest";
  }

  // ---------- small helpers ----------

  function tenthsToText(tenths) {
    return (tenths / 10).toFixed(1);
  }

  /** Integer units per km and per minute for a data set. */
  function unitsOf(data) {
    var u = data.UNITS || {};
    return { perKm: u.distancePerKm || 10, perMin: u.timePerMin || 10 };
  }

  /** "12.3" minutes, "4.5" km and "6.7" risk points from integer units. */
  function formatTime(data, units) {
    return (units / unitsOf(data).perMin).toFixed(1);
  }
  function formatDistance(data, units) {
    return (units / unitsOf(data).perKm).toFixed(1);
  }
  function formatRisk(data, units) {
    return (units / unitsOf(data).perKm).toFixed(1);
  }

  function indexBy(list, key) {
    var out = {};
    for (var i = 0; i < list.length; i++) out[list[i][key]] = list[i];
    return out;
  }

  function sameArray(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function signature(nodes) {
    return nodes.join(">");
  }

  function comparePaths(a, b) {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.tie !== b.tie) return a.tie - b.tie;
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
  }

  // ---------- traffic levels ----------

  /** Full edgeId -> level map for a scenario (unlisted roads are "light"). */
  function levelsForScenario(data, scenarioId) {
    var scenario = null;
    for (var i = 0; i < data.SCENARIOS.length; i++) {
      if (data.SCENARIOS[i].id === scenarioId) scenario = data.SCENARIOS[i];
    }
    var levels = {};
    data.EDGES.forEach(function (e) {
      levels[e.id] = scenario && scenario.levels[e.id] ? scenario.levels[e.id] : "light";
    });
    return levels;
  }

  /** Validates a level map. Missing or unknown values fall back to "light". */
  function normalizeLevels(data, levels) {
    var out = {};
    data.EDGES.forEach(function (e) {
      var lv = levels && levels[e.id];
      out[e.id] = Object.prototype.hasOwnProperty.call(data.CONGESTION_LEVELS, lv) ? lv : "light";
    });
    return out;
  }

  // ---------- time of day ----------

  /** The time band covering a whole hour, or null if outside the day. */
  function bandForHour(data, hour) {
    if (typeof hour !== "number" || Math.floor(hour) !== hour) return null;
    for (var i = 0; i < data.TIME_BANDS.length; i++) {
      var b = data.TIME_BANDS[i];
      if (hour >= b.from && hour <= b.to) return b;
    }
    return null;
  }

  var SEVERITY = { light: 0, moderate: 1, heavy: 2 };

  /**
   * Full edgeId -> level map for an hour of the day (null if no band).
   * A band can reuse a scenario, list levels per road ("levels"), and/or give
   * rules by road type and by hazard ("rules": { types: {...}, hazards: {...} }).
   * When several apply to a road, the most congested level wins.
   */
  function levelsForHour(data, hour) {
    var band = bandForHour(data, hour);
    if (!band) return null;
    if (band.scenario) return levelsForScenario(data, band.scenario);
    var rules = band.rules || {};
    var byType = rules.types || {};
    var byHazard = rules.hazards || {};
    var levels = {};
    data.EDGES.forEach(function (e) {
      var candidates = [(band.levels && band.levels[e.id]) || "light", byType[e.type] || "light"];
      (e.hazards || []).forEach(function (h) {
        if (byHazard[h]) candidates.push(byHazard[h]);
      });
      levels[e.id] = candidates.reduce(function (a, b) {
        return SEVERITY[b] > SEVERITY[a] ? b : a;
      });
    });
    return levels;
  }

  // ---------- graph ----------

  /** Risk weight per km for a road, and its hazards in display order. */
  function edgeRisk(data, edge) {
    var ids = (edge.hazards || []).filter(function (h) {
      if (!data.HAZARDS[h]) throw new Error("Unknown hazard " + h + " on " + edge.id);
      return true;
    });
    ids.sort(function (a, b) {
      return data.HAZARD_ORDER.indexOf(a) - data.HAZARD_ORDER.indexOf(b);
    });
    var weight = data.BASE_RISK;
    ids.forEach(function (h) { weight += data.HAZARDS[h].weight; });
    return {
      riskWeight: weight,
      hazards: ids.map(function (h) {
        return { id: h, label: data.HAZARDS[h].label, weight: data.HAZARDS[h].weight };
      })
    };
  }

  /** Assumed free-flow speed: the road's own value if set, else its type's. */
  function freeFlowSpeed(data, edge) {
    var type = data.ROAD_TYPES[edge.type];
    return edge.freeFlowKmh || (type && type.freeFlowKmh);
  }

  function edgeTimes(data, edge, level) {
    var kmh = freeFlowSpeed(data, edge);
    if (!(kmh > 0) || !(edge.distanceKm > 0)) {
      throw new Error("Invalid road data for " + edge.id);
    }
    // Free-flow time is rounded once to a whole time unit (0.1 min in the
    // demo); the estimated time is that value times the factor, so every
    // table row can be checked by hand: 4.5 min x 1.6 = 7.2 min.
    var freeFlowUnits = Math.round((edge.distanceKm / kmh) * 60 * unitsOf(data).perMin);
    var factor = data.CONGESTION_LEVELS[level].factor;
    return {
      freeFlowUnits: freeFlowUnits,
      timeUnits: factor === null ? null : Math.round(freeFlowUnits * factor + 1e-9)
    };
  }

  function buildGraph(data, levels, priority) {
    var lv = normalizeLevels(data, levels);
    var pr = PRIORITIES[normalizePriority(priority)];
    var perKm = unitsOf(data).perKm;
    var adj = {};
    var edgeInfo = {};
    data.NODES.forEach(function (n) {
      adj[n.id] = [];
    });
    data.EDGES.forEach(function (e) {
      if (!adj[e.from] || !adj[e.to]) throw new Error("Road " + e.id + " references an unknown location");
      var t = edgeTimes(data, e, lv[e.id]);
      var risk = edgeRisk(data, e);
      var distanceUnits = Math.round(e.distanceKm * perKm);
      var info = {
        edge: e,
        level: lv[e.id],
        factor: data.CONGESTION_LEVELS[lv[e.id]].factor,
        distanceUnits: distanceUnits,
        freeFlowUnits: t.freeFlowUnits,
        timeUnits: t.timeUnits,
        hazards: risk.hazards,
        riskWeight: risk.riskWeight,
        riskUnits: distanceUnits * risk.riskWeight
      };
      info.cost = info[pr.cost];
      info.tie = info[pr.tie];
      edgeInfo[e.id] = info;
      if (t.timeUnits !== null) {
        adj[e.from].push({ to: e.to, edgeId: e.id });
        if (!e.oneway) adj[e.to].push({ to: e.from, edgeId: e.id });
      }
    });
    Object.keys(adj).forEach(function (id) {
      adj[id].sort(function (a, b) {
        return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
      });
    });
    return {
      adj: adj,
      edgeInfo: edgeInfo,
      levels: lv,
      priority: normalizePriority(priority),
      nodeIds: Object.keys(adj).sort()
    };
  }

  function makePath(graph, nodes, edges) {
    var out = { nodes: nodes, edges: edges, timeUnits: 0, distanceUnits: 0, riskUnits: 0, cost: 0, tie: 0 };
    for (var i = 0; i < edges.length; i++) {
      var info = graph.edgeInfo[edges[i]];
      out.timeUnits += info.timeUnits;
      out.distanceUnits += info.distanceUnits;
      out.riskUnits += info.riskUnits;
      out.cost += info.cost;
      out.tie += info.tie;
    }
    out.signature = signature(nodes);
    return out;
  }

  // ---------- priority queue ----------

  /** Queue entries [cost, tie, id] in the order Dijkstra settles nodes. */
  function entryLess(a, b) {
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return a[2] < b[2];
  }

  function heapPush(heap, item) {
    heap.push(item);
    var i = heap.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (!entryLess(heap[i], heap[p])) break;
      var t = heap[i]; heap[i] = heap[p]; heap[p] = t;
      i = p;
    }
  }

  function heapPop(heap) {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1;
        var r = l + 1;
        var m = i;
        if (l < heap.length && entryLess(heap[l], heap[m])) m = l;
        if (r < heap.length && entryLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        var t = heap[i]; heap[i] = heap[m]; heap[m] = t;
        i = m;
      }
    }
    return top;
  }

  /**
   * Dijkstra search from source. Stops once target is settled (or runs over
   * the whole graph if target is null). Returns the search tree.
   * Nodes are settled in order of (cost, tie-breaker, location id), so the
   * result is fully deterministic. A binary heap keeps it fast on the real
   * road network.
   */
  function search(graph, source, target, blockedNodes, blockedEdges) {
    blockedNodes = blockedNodes || new Set();
    blockedEdges = blockedEdges || new Set();
    var best = {};
    var bestTie = {};
    var prevNode = {};
    var prevEdge = {};
    var done = {};
    var heap = [[0, 0, source]];
    best[source] = 0;
    bestTie[source] = 0;

    while (heap.length) {
      var top = heapPop(heap);
      var u = top[2];
      if (done[u] || blockedNodes.has(u) || top[0] !== best[u] || top[1] !== bestTie[u]) continue;
      if (u === target) break;
      done[u] = true;
      var nbrs = graph.adj[u];
      for (var j = 0; j < nbrs.length; j++) {
        var v = nbrs[j].to;
        var eid = nbrs[j].edgeId;
        if (done[v] || blockedNodes.has(v) || blockedEdges.has(eid)) continue;
        var info = graph.edgeInfo[eid];
        var nt = best[u] + info.cost;
        var nd = bestTie[u] + info.tie;
        if (best[v] === undefined || nt < best[v] || (nt === best[v] && nd < bestTie[v])) {
          best[v] = nt;
          bestTie[v] = nd;
          prevNode[v] = u;
          prevEdge[v] = eid;
          heapPush(heap, [nt, nd, v]);
        }
      }
    }
    return { best: best, prevNode: prevNode, prevEdge: prevEdge };
  }

  function pathFromTree(graph, tree, source, target) {
    if (tree.best[target] === undefined) return null;
    var nodes = [target];
    var edges = [];
    var cur = target;
    while (cur !== source) {
      edges.push(tree.prevEdge[cur]);
      cur = tree.prevNode[cur];
      nodes.push(cur);
    }
    return makePath(graph, nodes.reverse(), edges.reverse());
  }

  /**
   * Dijkstra's algorithm on the graph's cost: travel time for "fastest",
   * risk points for "safest". Ties are broken by the priority's tie-breaker
   * (shorter distance, or shorter time), then by location id.
   * Returns null if target is unreachable.
   */
  function dijkstra(graph, source, target, blockedNodes, blockedEdges) {
    return pathFromTree(graph, search(graph, source, target, blockedNodes, blockedEdges), source, target);
  }

  /** Yen's algorithm: up to k loopless paths in order of travel time. */
  function kShortestPaths(graph, source, target, k) {
    var first = dijkstra(graph, source, target);
    if (!first) return [];
    var A = [first];
    var B = [];
    var seen = {};
    seen[first.signature] = true;

    for (var n = 1; n < k; n++) {
      var last = A[n - 1];
      for (var i = 0; i < last.nodes.length - 1; i++) {
        var spur = last.nodes[i];
        var rootNodes = last.nodes.slice(0, i + 1);
        var rootEdges = last.edges.slice(0, i);
        var blockedEdges = new Set();
        A.forEach(function (p) {
          if (p.edges.length > i && sameArray(p.nodes.slice(0, i + 1), rootNodes)) {
            blockedEdges.add(p.edges[i]);
          }
        });
        var blockedNodes = new Set(rootNodes.slice(0, i));
        var spurPath = dijkstra(graph, spur, target, blockedNodes, blockedEdges);
        if (!spurPath) continue;
        var cand = makePath(
          graph,
          rootNodes.slice(0, i).concat(spurPath.nodes),
          rootEdges.concat(spurPath.edges)
        );
        if (seen[cand.signature]) continue;
        seen[cand.signature] = true;
        B.push(cand);
      }
      if (!B.length) break;
      B.sort(comparePaths);
      A.push(B.shift());
    }
    return A;
  }

  /**
   * Penalty method, for large networks where Yen's algorithm is too slow
   * and finds only tiny detours. The first route is Dijkstra's optimum. Each
   * further round makes every road of the last route found penaltyFactor
   * times more expensive and searches again, which pushes the search onto
   * genuinely different roads. Routes are then re-costed with the real
   * weights and sorted, so the optimum always stays first.
   */
  function penaltyPaths(graph, source, target, rounds) {
    var first = dijkstra(graph, source, target);
    if (!first) return [];
    var penalized = { adj: graph.adj, nodeIds: graph.nodeIds, edgeInfo: {} };
    Object.keys(graph.edgeInfo).forEach(function (id) {
      var info = graph.edgeInfo[id];
      penalized.edgeInfo[id] = { cost: info.cost, tie: info.tie };
    });
    var found = [first];
    var seen = {};
    seen[first.signature] = true;
    var last = first;
    for (var i = 1; i < rounds; i++) {
      last.edges.forEach(function (eid) {
        var p = penalized.edgeInfo[eid];
        p.cost = Math.round(p.cost * SETTINGS.penaltyFactor) + 1;
      });
      var next = dijkstra(penalized, source, target);
      if (!next) break;
      last = next;
      var real = makePath(graph, next.nodes, next.edges);
      if (seen[real.signature]) continue;
      seen[real.signature] = true;
      found.push(real);
    }
    return found.sort(comparePaths);
  }

  function candidatePaths(graph, source, target) {
    return graph.nodeIds.length > SETTINGS.yenMaxNodes
      ? penaltyPaths(graph, source, target, SETTINGS.penaltyRounds)
      : kShortestPaths(graph, source, target, SETTINGS.candidatePool);
  }

  function sharedLengthRatio(graph, candidate, other) {
    var otherEdges = new Set(other.edges);
    var shared = 0;
    candidate.edges.forEach(function (e) {
      if (otherEdges.has(e)) shared += graph.edgeInfo[e].distanceUnits;
    });
    return candidate.distanceUnits === 0 ? 1 : shared / candidate.distanceUnits;
  }

  /**
   * Keep the fastest path, then add alternatives that share at most
   * maxSharedLength of their length with every route already chosen.
   * If that leaves only one route, add the next-best path anyway so the
   * user still has a comparison whenever the network allows one.
   * mustInclude (optional) is the best path under the OTHER priority; it is
   * always shown, replacing the lowest-ranked route if the list is full, so
   * the user can see the fastest and the safest route side by side.
   */
  function selectDistinct(graph, paths, mustInclude) {
    if (!paths.length) return [];
    var chosen = [paths[0]];
    for (var i = 1; i < paths.length && chosen.length < SETTINGS.maxRoutes; i++) {
      var p = paths[i];
      var distinct = chosen.every(function (c) {
        return sharedLengthRatio(graph, p, c) <= SETTINGS.maxSharedLength;
      });
      if (distinct) chosen.push(p);
    }
    if (chosen.length < 2 && paths.length > 1) chosen.push(paths[1]);
    if (mustInclude && !chosen.some(function (c) { return c.signature === mustInclude.signature; })) {
      if (chosen.length >= SETTINGS.maxRoutes) chosen.pop();
      chosen.push(mustInclude);
    }
    return chosen.sort(comparePaths);
  }

  function classify(ratio) {
    if (ratio <= SETTINGS.lightMaxRatio) return { key: "light", label: "Light traffic" };
    if (ratio <= SETTINGS.moderateMaxRatio) return { key: "moderate", label: "Moderate traffic" };
    return { key: "heavy", label: "Heavy traffic" };
  }

  /**
   * Safety rating from the average risk points per km.
   * "tone" reuses the green / amber / red colour scale.
   */
  function classifySafety(riskPerKm) {
    if (riskPerKm <= SETTINGS.saferMaxRisk) return { key: "safer", label: "Safer route", tone: "light" };
    if (riskPerKm <= SETTINGS.cautionMaxRisk) return { key: "caution", label: "Some hazards", tone: "moderate" };
    return { key: "risk", label: "Higher risk", tone: "heavy" };
  }

  function describeRoute(data, graph, path, nodeById) {
    var segments = path.edges.map(function (eid, i) {
      var info = graph.edgeInfo[eid];
      var type = data.ROAD_TYPES[info.edge.type];
      return {
        edgeId: eid,
        from: path.nodes[i],
        to: path.nodes[i + 1],
        fromName: nodeById[path.nodes[i]].name,
        toName: nodeById[path.nodes[i + 1]].name,
        roadName: info.edge.name,
        corridor: info.edge.corridor,
        roadType: type.label,
        freeFlowKmh: freeFlowSpeed(data, info.edge),
        level: info.level,
        levelLabel: data.CONGESTION_LEVELS[info.level].label,
        factor: info.factor,
        distanceUnits: info.distanceUnits,
        freeFlowUnits: info.freeFlowUnits,
        timeUnits: info.timeUnits,
        hazards: info.hazards,
        riskWeight: info.riskWeight,
        riskUnits: info.riskUnits
      };
    });

    var time = 0;
    var dist = 0;
    var free = 0;
    var risk = 0;
    var byLevel = { light: 0, moderate: 0, heavy: 0 };
    var byCorridor = {};
    var hazardsOnRoute = [];
    segments.forEach(function (s) {
      time += s.timeUnits;
      dist += s.distanceUnits;
      free += s.freeFlowUnits;
      risk += s.riskUnits;
      byLevel[s.level] += s.distanceUnits;
      byCorridor[s.corridor] = (byCorridor[s.corridor] || 0) + s.distanceUnits;
      s.hazards.forEach(function (h) {
        hazardsOnRoute.push({ id: h.id, label: h.label, roadName: s.roadName });
      });
    });
    var ratio = free > 0 ? time / free : 1;

    var corridors = Object.keys(byCorridor).sort(function (a, b) {
      return byCorridor[b] - byCorridor[a] || (a < b ? -1 : 1);
    });

    return {
      signature: path.signature,
      nodes: path.nodes.slice(),
      nodeNames: path.nodes.map(function (id) {
        return nodeById[id].name;
      }),
      edges: path.edges.slice(),
      segments: segments,
      timeUnits: time,
      distanceUnits: dist,
      freeFlowUnits: free,
      delayUnits: time - free,
      delayPercent: Math.round((ratio - 1) * 100),
      congestion: classify(ratio),
      riskUnits: risk,
      safety: classifySafety(dist > 0 ? risk / dist : 0),
      hazards: hazardsOnRoute,
      levelDistanceUnits: byLevel,
      corridors: corridors
    };
  }

  /**
   * Friendly names. The fastest route is named after its longest road.
   * Each alternative is named after its longest road that no higher-ranked
   * route uses, i.e. the road that makes it different. Roads without a name
   * (empty corridor) are skipped; a route of only unnamed roads is "via local
   * streets".
   */
  function assignNames(routes) {
    var usedCorridors = {};
    var usedNames = {};
    routes.forEach(function (r) {
      var named = r.corridors.filter(function (c) { return c; });
      var pick = null;
      for (var i = 0; i < named.length; i++) {
        if (!usedCorridors[named[i]]) {
          pick = named[i];
          break;
        }
      }
      var name = "via " + (pick || named[0] || "local streets");
      var base = name;
      var n = 2;
      while (usedNames[name]) name = base + " (" + n++ + ")";
      usedNames[name] = true;
      r.name = name;
      r.corridors.forEach(function (c) {
        usedCorridors[c] = true;
      });
    });
  }

  /**
   * Re-times an existing path (list of edge ids) under new traffic levels.
   * Returns { closed: true } if any of its roads is now closed.
   */
  function evaluatePath(data, levels, edgeIds) {
    var graph = buildGraph(data, levels);
    var time = 0;
    var dist = 0;
    var risk = 0;
    for (var i = 0; i < edgeIds.length; i++) {
      var info = graph.edgeInfo[edgeIds[i]];
      if (!info) throw new Error("Unknown road " + edgeIds[i]);
      if (info.timeUnits === null) return { closed: true, timeUnits: null, distanceUnits: null, riskUnits: null };
      time += info.timeUnits;
      dist += info.distanceUnits;
      risk += info.riskUnits;
    }
    return { closed: false, timeUnits: time, distanceUnits: dist, riskUnits: risk };
  }

  /** Names of closed roads, each once, in data order. */
  function closedRoadNames(data, levels) {
    var seen = {};
    return data.EDGES.filter(function (e) {
      if (levels[e.id] !== "closed" || seen[e.name]) return false;
      seen[e.name] = true;
      return true;
    }).map(function (e) {
      return e.name;
    });
  }

  function fail(code, message, extra) {
    var out = { ok: false, code: code, message: message, routes: [] };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /**
   * Main entry point.
   * options.priority: "fastest" (default) or "safest".
   * @returns {{ok:true, routes:Array, recommended:Object} | {ok:false, code:string, message:string}}
   */
  function findRoutes(data, levels, originId, destinationId, options) {
    var priority = normalizePriority(options && options.priority);
    var nodeById = indexBy(data.NODES, "id");
    if (!originId) return fail("MISSING_ORIGIN", "Choose a starting point.");
    if (!destinationId) return fail("MISSING_DESTINATION", "Choose a destination.");
    if (!nodeById[originId]) return fail("INVALID_LOCATION", "The starting point is not in this road network.");
    if (!nodeById[destinationId]) return fail("INVALID_LOCATION", "The destination is not in this road network.");
    if (originId === destinationId) {
      return fail("SAME_LOCATION", "Start and destination are the same place. Choose a different destination.");
    }

    var graph = buildGraph(data, levels, priority);
    var paths = candidatePaths(graph, originId, destinationId);

    if (!paths.length) {
      var closed = closedRoadNames(data, graph.levels);
      return fail(
        "UNREACHABLE",
        "No open road connects " + nodeById[originId].name + " to " + nodeById[destinationId].name +
          " under the current traffic conditions.",
        { closedRoads: closed }
      );
    }

    // Best route under the other priority, re-built on this graph so its
    // cost fields are comparable. It is always shown alongside.
    var otherPriority = priority === "fastest" ? "safest" : "fastest";
    var otherFound = dijkstra(buildGraph(data, levels, otherPriority), originId, destinationId);
    var otherBest = makePath(graph, otherFound.nodes, otherFound.edges);
    var bestSig = {};
    bestSig[priority] = paths[0].signature;
    bestSig[otherPriority] = otherBest.signature;

    var routes = selectDistinct(graph, paths, otherBest).map(function (p) {
      return describeRoute(data, graph, p, nodeById);
    });
    assignNames(routes);

    var best = routes[0];
    routes.forEach(function (r, i) {
      r.rank = i + 1;
      r.isRecommended = i === 0;
      r.isFastest = r.signature === bestSig.fastest;
      r.isSafest = r.signature === bestSig.safest;
      r.extraTimeUnits = r.timeUnits - best.timeUnits;
      r.extraDistanceUnits = r.distanceUnits - best.distanceUnits;
      r.extraRiskUnits = r.riskUnits - best.riskUnits;
    });

    return {
      ok: true,
      priority: priority,
      origin: nodeById[originId],
      destination: nodeById[destinationId],
      routes: routes,
      recommended: best,
      candidatesExamined: paths.length
    };
  }

  /**
   * Emergency: the fastest route from originId to the nearest hospital
   * (any location with kind "hospital", except ones marked emergency: false,
   * such as eye or dental hospitals), measured by journey time under the
   * current traffic. One Dijkstra search from the start reaches every
   * hospital at once. Returns a findRoutes result plus emergency: true,
   * hospital: the chosen location, and nearestHospitals: up to three
   * { hospital, timeUnits } in order of journey time.
   */
  function findEmergencyRoute(data, levels, originId) {
    var nodeById = indexBy(data.NODES, "id");
    if (!originId) return fail("MISSING_ORIGIN", "Choose where you are now as the Start, then press Emergency again.");
    if (!nodeById[originId]) return fail("INVALID_LOCATION", "The starting point is not in this road network.");
    var hospitals = data.NODES.filter(function (n) { return n.kind === "hospital" && n.emergency !== false; });
    if (!hospitals.length) return fail("NO_HOSPITAL", "This road network has no hospital.");
    if (hospitals.some(function (h) { return h.id === originId; })) {
      return fail("AT_HOSPITAL", "You are already at " + nodeById[originId].name + ".");
    }

    var tree = search(buildGraph(data, levels, "fastest"), originId, null);
    var reachable = hospitals.filter(function (h) {
      return tree.best[h.id] !== undefined;
    }).sort(function (a, b) {
      return tree.best[a.id] - tree.best[b.id] || (a.id < b.id ? -1 : 1);
    });
    var best = reachable.length ? findRoutes(data, levels, originId, reachable[0].id, { priority: "fastest" }) : null;
    if (best && best.ok) {
      best.nearestHospitals = reachable.slice(0, 3).map(function (h) {
        return { hospital: h, timeUnits: tree.best[h.id] };
      });
    } else {
      best = null;
    }

    if (!best) {
      var closed = closedRoadNames(data, normalizeLevels(data, levels));
      return fail(
        "UNREACHABLE",
        "No open road reaches a hospital from " + nodeById[originId].name + " under the current traffic conditions.",
        { closedRoads: closed, emergency: true }
      );
    }
    best.emergency = true;
    best.hospital = best.destination;
    return best;
  }

  return {
    SETTINGS: SETTINGS,
    PRIORITIES: PRIORITIES,
    findRoutes: findRoutes,
    findEmergencyRoute: findEmergencyRoute,
    evaluatePath: evaluatePath,
    levelsForScenario: levelsForScenario,
    levelsForHour: levelsForHour,
    bandForHour: bandForHour,
    classifySafety: classifySafety,
    normalizeLevels: normalizeLevels,
    buildGraph: buildGraph,
    dijkstra: dijkstra,
    kShortestPaths: kShortestPaths,
    classify: classify,
    tenthsToText: tenthsToText,
    unitsOf: unitsOf,
    formatTime: formatTime,
    formatDistance: formatDistance,
    formatRisk: formatRisk
  };
});
