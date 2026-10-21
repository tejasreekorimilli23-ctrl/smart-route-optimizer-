/*
 * Map view: draws the schematic road network as SVG.
 * Pure drawing code. It reads data and the current result, and never runs
 * route calculations itself. Exposes window.MapView.
 */
(function (root) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  var TRAFFIC_COLORS = {
    light: "#22A565",
    moderate: "#E3A11B",
    heavy: "#DD4545",
    closed: "#6B7A92"
  };
  var CYAN = "#3FD8EA";
  var NAVY = "#0D1C36";

  // Alternative route styles (index 1 = Route 2, index 2 = Route 3).
  var ALT_STYLES = [
    null,
    { stroke: "#F1F5FB", dash: "12 7", width: 3.5, cap: "butt", offset: 13 },
    { stroke: "#9FB2D0", dash: "0.1 9", width: 5.5, cap: "round", offset: -13 }
  ];

  // Label placement per location: dx/dy from the node and text anchor.
  var LABELS = {
    RLY: { dx: -14, dy: -22, anchor: "start" },
    SCH: { dx: -14, dy: 30, anchor: "end" },
    MKT: { dx: 0, dy: -24, anchor: "middle" },
    HSP: { dx: 0, dy: -24, anchor: "middle" },
    BUS: { dx: -20, dy: 6, anchor: "end", lines: ["Bus", "Station"] },
    CLK: { dx: 14, dy: 34, anchor: "start" },
    TWN: { dx: -14, dy: -18, anchor: "end" },
    COL: { dx: 20, dy: -4, anchor: "start", lines: ["Engineering", "College"] },
    RNG: { dx: 0, dy: 36, anchor: "middle" },
    IND: { dx: 0, dy: 36, anchor: "middle" },
    STD: { dx: 20, dy: 6, anchor: "start", lines: ["Sports", "Stadium"] },
    LKV: { dx: -20, dy: 6, anchor: "end" }
  };

  function el(name, attrs, parent) {
    var node = document.createElementNS(NS, name);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
      });
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function pointsAttr(points) {
    return points
      .map(function (p) {
        return p.x.toFixed(1) + "," + p.y.toFixed(1);
      })
      .join(" ");
  }

  function unitNormal(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: -dy / len, y: dx / len };
  }

  /** Shifts a polyline sideways by d pixels, with mitred corners. */
  function offsetPolyline(points, d) {
    if (!d) return points;
    return points.map(function (p, i) {
      var n1 = i > 0 ? unitNormal(points[i - 1], p) : null;
      var n2 = i < points.length - 1 ? unitNormal(p, points[i + 1]) : null;
      var n;
      var scale = d;
      if (!n1) n = n2;
      else if (!n2) n = n1;
      else {
        var mx = n1.x + n2.x;
        var my = n1.y + n2.y;
        var ml = Math.sqrt(mx * mx + my * my);
        if (ml < 1e-6) {
          n = n1;
        } else {
          n = { x: mx / ml, y: my / ml };
          var cos = n.x * n1.x + n.y * n1.y;
          scale = d / Math.max(cos, 0.4);
        }
      }
      return { x: p.x + n.x * scale, y: p.y + n.y * scale };
    });
  }

  function addLabel(parent, node, opts) {
    var cfg = LABELS[node.id] || { dx: 14, dy: 6, anchor: "start" };
    var lines = cfg.lines || [node.name];
    var text = el("text", {
      x: node.x + cfg.dx,
      y: node.y + cfg.dy - (lines.length - 1) * 9,
      "text-anchor": cfg.anchor,
      class: "map-label" + (opts.emphasis ? " is-endpoint" : "")
    }, parent);
    lines.forEach(function (line, i) {
      var t = el("tspan", { x: node.x + cfg.dx, dy: i === 0 ? 0 : 19 }, text);
      t.textContent = line;
    });
  }

  /**
   * opts: {
   *   data, levels,
   *   routes: array of route objects (may be empty),
   *   focusedSig: signature of the route being inspected,
   *   origin, destination: node ids for the markers (may be null),
   *   selectedEdgeId: road selected in the editor
   * }
   */
  function render(svg, opts) {
    var layer = svg.querySelector("#map-layer");
    while (layer.firstChild) layer.removeChild(layer.firstChild);

    var data = opts.data;
    var nodeById = {};
    data.NODES.forEach(function (n) {
      nodeById[n.id] = n;
    });
    var routes = opts.routes || [];
    var focusedSig = opts.focusedSig;
    var focusingAlt = routes.length > 1 && routes[0].signature !== focusedSig;

    function routePoints(route) {
      return route.nodes.map(function (id) {
        return nodeById[id];
      });
    }

    // 1. Recommended route band, drawn under the roads.
    var gBand = el("g", { class: "layer-band" }, layer);
    if (routes.length) {
      el("polyline", {
        points: pointsAttr(routePoints(routes[0])),
        fill: "none",
        stroke: CYAN,
        "stroke-width": 24,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        opacity: focusingAlt ? 0.4 : 1
      }, gBand);
    }

    // 2. Roads, coloured by simulated traffic.
    var gRoads = el("g", { class: "layer-roads" }, layer);
    data.EDGES.forEach(function (e) {
      var a = nodeById[e.from];
      var b = nodeById[e.to];
      var level = opts.levels[e.id] || "light";
      var selected = e.id === opts.selectedEdgeId;
      var g = el("g", { class: "road" + (selected ? " is-selected" : ""), "data-edge": e.id }, gRoads);
      var title = el("title", null, g);
      var hazards = (e.hazards || []).map(function (h) {
        if (opts.hazardLabel) return opts.hazardLabel(h);
        return data.HAZARDS && data.HAZARDS[h] ? data.HAZARDS[h].label.toLowerCase() : h;
      });
      title.textContent = opts.t
        ? opts.t("map.roadTip", { road: e.name, level: opts.t("level." + level), hazards: hazards.join(", ") || "–" })
        : e.name + ": " + data.CONGESTION_LEVELS[level].label.toLowerCase() +
          " traffic (simulated)" + (hazards.length ? "; hazards: " + hazards.join(", ") : "") + ". Click to change.";
      if (selected) {
        // White casing marks the road chosen in the "change traffic" editor.
        el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#FFFFFF", "stroke-width": 15, "stroke-linecap": "round" }, g);
      }
      el("line", {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: TRAFFIC_COLORS[level],
        "stroke-width": selected ? 9 : 7,
        "stroke-linecap": "round",
        "stroke-dasharray": level === "closed" ? "8 7" : null
      }, g);
      // Wide invisible hit area so roads are easy to click or tap.
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "transparent", "stroke-width": 26, class: "road-hit" }, g);
      if (level === "closed") {
        var mx = (a.x + b.x) / 2;
        var my = (a.y + b.y) / 2;
        el("circle", { cx: mx, cy: my, r: 11, fill: NAVY, stroke: "#C8D2E0", "stroke-width": 2 }, g);
        el("path", { d: "M" + (mx - 4.5) + " " + (my - 4.5) + "l9 9m0 -9l-9 9", stroke: "#FFFFFF", "stroke-width": 2.4, "stroke-linecap": "round" }, g);
      }
    });

    // 2b. Warning triangles on roads with a simulated safety hazard, placed
    // a third of the way along so they do not cover the closed-road marker.
    var gHazards = el("g", { class: "layer-hazards", "aria-hidden": "true" }, layer);
    data.EDGES.forEach(function (e) {
      if (!e.hazards || !e.hazards.length) return;
      var a = nodeById[e.from];
      var b = nodeById[e.to];
      var x = a.x + (b.x - a.x) * 0.33;
      var y = a.y + (b.y - a.y) * 0.33;
      var g = el("g", { class: "hazard-mark" }, gHazards);
      el("path", {
        d: "M" + x + " " + (y - 11) + "l10 17.5h-20z",
        fill: "#FFD23F",
        stroke: NAVY,
        "stroke-width": 2,
        "stroke-linejoin": "round"
      }, g);
      el("path", {
        d: "M" + x + " " + (y - 4.5) + "v5.5M" + x + " " + (y + 3.6) + "v0.2",
        stroke: NAVY,
        "stroke-width": 2.4,
        "stroke-linecap": "round"
      }, g);
    });

    // 3. Alternative routes as offset dashed / dotted lines.
    var gAlt = el("g", { class: "layer-alts" }, layer);
    routes.forEach(function (r, i) {
      if (i === 0 || !ALT_STYLES[i]) return;
      var s = ALT_STYLES[i];
      var focused = r.signature === focusedSig;
      el("polyline", {
        points: pointsAttr(offsetPolyline(routePoints(r), s.offset)),
        fill: "none",
        stroke: s.stroke,
        "stroke-width": focused ? s.width + 1.5 : s.width,
        "stroke-dasharray": s.dash,
        "stroke-linecap": s.cap,
        "stroke-linejoin": "round",
        opacity: focusingAlt && !focused ? 0.35 : 1
      }, gAlt);
    });

    // 4. Locations.
    var gNodes = el("g", { class: "layer-nodes" }, layer);
    data.NODES.forEach(function (n) {
      var isStart = n.id === opts.origin;
      var isEnd = n.id === opts.destination;
      if (isStart) {
        el("circle", { cx: n.x, cy: n.y, r: 14, fill: CYAN, stroke: NAVY, "stroke-width": 4 }, gNodes);
      } else if (isEnd) {
        el("circle", { cx: n.x, cy: n.y, r: 13, fill: NAVY, stroke: CYAN, "stroke-width": 6 }, gNodes);
        el("circle", { cx: n.x, cy: n.y, r: 4.5, fill: CYAN }, gNodes);
      } else {
        el("circle", { cx: n.x, cy: n.y, r: 8.5, fill: "#FFFFFF", stroke: NAVY, "stroke-width": 3.5 }, gNodes);
      }
      addLabel(gNodes, n, { emphasis: isStart || isEnd });
    });
  }

  root.MapView = { render: render, TRAFFIC_COLORS: TRAFFIC_COLORS };
})(typeof self !== "undefined" ? self : this);
