/*
 * Real map view: draws the real road network on an OpenStreetMap base map
 * with Leaflet. Roads are coloured by (estimated) traffic, routes are drawn
 * on top, and clicking the map or a road opens a small menu.
 * Pure drawing code: it never runs route calculations itself.
 * Exposes window.RealMapView. Needs window.L (Leaflet).
 */
(function (root) {
  "use strict";

  var TRAFFIC_COLORS = { light: "#22A565", moderate: "#E3A11B", heavy: "#DD4545", closed: "#6B7A92" };
  var CYAN = "#0FB5CB";
  var NAVY = "#0D1C36";
  var ROAD_WEIGHT = {
    trunk: 6, motorway: 6, primary: 5.5, secondary: 5, tertiary: 4,
    trunk_link: 4, primary_link: 4, secondary_link: 3.5, tertiary_link: 3.5
  };
  // Small lanes are only coloured when they are not flowing freely, so the
  // base map stays readable (they can still be clicked).
  function roadStyle(type, level) {
    var major = !!ROAD_WEIGHT[type];
    return {
      color: TRAFFIC_COLORS[level],
      opacity: level !== "light" ? 0.9 : major ? 0.6 : 0,
      dashArray: level === "closed" ? "6 6" : null
    };
  }

  // Symbols for incident markers (plain characters, so no image files are needed).
  var INCIDENT_ICONS = {
    accident: "!", breakdown: "!", closed: "⛔", roadworks: "⚒", laneclosed: "⚒",
    flooding: "≈", jam: "≡", danger: "!", fog: "~", rain: "~", ice: "*", wind: "~", unknown: "?"
  };

  var ALT_STYLES = [
    null,
    { color: "#1B2B48", dashArray: "10 8", weight: 4.5 },
    { color: "#5B6B86", dashArray: "1 9", weight: 6, lineCap: "round" }
  ];

  var map = null;
  var renderer = null;
  var roadLines = {}; // edgeId -> polyline
  var drawnLevels = {}; // edgeId -> level currently drawn
  var roadType = {}; // edgeId -> road type
  var roadLayer = null;
  var overlay = null; // routes, markers, selection
  var dataRef = null;
  var lastFitKey = null;
  // Text comes from the app (api.t), so the map follows the page language.
  var api = { onAction: null, t: null, roadName: null, hazardLabel: null };
  var liveLayer = null;
  var liveUrl = null;
  var FALLBACK = {
    "map.thisPoint": "This point",
    "map.startHere": "Start here",
    "map.goHere": "Go here (destination)",
    "map.trafficOnSection": "Traffic on this section:",
    "map.tipStart": "Start: {name}",
    "map.tipDestination": "Destination: {name}",
    "map.tipHazard": "{hazard} on {road}",
    "map.tipBlackspot": "Accident black spot: {name}"
  };

  function tr(key, params) {
    if (api.t) return api.t(key, params);
    var s = FALLBACK[key] || key;
    Object.keys(params || {}).forEach(function (k) { s = s.replace("{" + k + "}", params[k]); });
    return s;
  }

  function roadName(edge) {
    return api.roadName ? api.roadName(edge) : edge.name;
  }

  function latLngs(geom) {
    var out = [];
    for (var i = 0; i < geom.length; i += 2) out.push([geom[i], geom[i + 1]]);
    return out;
  }

  function act(action, payload) {
    if (api.onAction) api.onAction(action, payload);
  }

  function menu(title, items) {
    var box = document.createElement("div");
    box.className = "map-menu";
    var h = document.createElement("p");
    h.className = "map-menu-title";
    h.textContent = title;
    box.appendChild(h);
    items.forEach(function (it) {
      if (it.label) {
        var p = document.createElement("p");
        p.className = "map-menu-label";
        p.textContent = it.label;
        box.appendChild(p);
        return;
      }
      var b = document.createElement("button");
      b.type = "button";
      b.className = "map-menu-btn" + (it.className ? " " + it.className : "");
      b.textContent = it.text;
      if (it.pressed) b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", function () {
        map.closePopup();
        it.run();
      });
      box.appendChild(b);
    });
    return box;
  }

  // Kinds of problem people can report (see js/community.js).
  var REPORT_TYPES = ["accident", "closed", "bandh", "flooding", "jam", "works", "other"];
  var REPORT_ICONS = { accident: "!", closed: "⛔", bandh: "✋", flooding: "≈", jam: "≡", works: "⚒", other: "?" };

  /** Second step of reporting: what is happening here? */
  function reportMenu(latlng, edgeId) {
    return menu(tr("map.reportWhat"), REPORT_TYPES.map(function (type) {
      return {
        text: (REPORT_ICONS[type] || "") + " " + tr("report.type." + type),
        className: "rp-" + type,
        run: function () { act("report", { lat: latlng.lat, lng: latlng.lng, edgeId: edgeId, type: type }); }
      };
    }));
  }

  function reportItem(latlng, edgeId) {
    return {
      text: tr("map.report"),
      className: "is-report",
      run: function () {
        // Opened after the current menu closes.
        setTimeout(function () {
          root.L.popup().setLatLng(latlng).setContent(reportMenu(latlng, edgeId)).openOn(map);
        }, 0);
      }
    };
  }

  function pointMenu(latlng, title) {
    return menu(title, [
      { text: tr("map.startHere"), run: function () { act("set-start", latlng); } },
      { text: tr("map.goHere"), run: function () { act("set-destination", latlng); } },
      reportItem(latlng, null)
    ]);
  }

  function roadMenu(edge, latlng) {
    var items = [
      { text: tr("map.startHere"), run: function () { act("set-start", latlng); } },
      { text: tr("map.goHere"), run: function () { act("set-destination", latlng); } },
      reportItem(latlng, edge.id),
      { label: tr("map.trafficOnSection") }
    ];
    dataRef.CONGESTION_ORDER.forEach(function (lv) {
      items.push({
        text: api.t ? api.t("level." + lv) : dataRef.CONGESTION_LEVELS[lv].label,
        className: "lv-" + lv,
        pressed: drawnLevels[edge.id] === lv,
        run: function () { act("set-level", { edgeId: edge.id, level: lv }); }
      });
    });
    return menu(roadName(edge), items);
  }

  /** Draws the road network of `data` (replacing any earlier one) and frames its area. */
  function showRoads(data) {
    dataRef = data;
    if (roadLayer) map.removeLayer(roadLayer);
    roadLayer = root.L.layerGroup();
    roadLines = {};
    drawnLevels = {};
    roadType = {};
    lastFitKey = null;
    data.EDGES.forEach(function (e) {
      roadType[e.id] = e.type;
      if (e.type === "access" || !e.geom) return;
      var line = root.L.polyline(latLngs(e.geom), Object.assign({
        renderer: renderer,
        weight: ROAD_WEIGHT[e.type] || 3
      }, roadStyle(e.type, "light")));
      line.on("click", function (ev) {
        root.L.DomEvent.stopPropagation(ev);
        act("select-road", e.id);
        root.L.popup().setLatLng(ev.latlng).setContent(roadMenu(e, ev.latlng)).openOn(map);
      });
      line.addTo(roadLayer);
      roadLines[e.id] = line;
      drawnLevels[e.id] = "light";
    });
    roadLayer.addTo(map);
    var b = data.AREA.bbox;
    map.setMaxBounds(root.L.latLngBounds([b[0] - 0.02, b[1] - 0.02], [b[2] + 0.02, b[3] + 0.02]));
    map.setView(data.AREA.center, data.AREA.zoom, { animate: false });
  }

  function init(container, data) {
    map = root.L.map(container, { zoomControl: true, preferCanvas: true, minZoom: 12, maxZoom: 19 });
    root.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    renderer = root.L.canvas({ tolerance: 6 });
    map.on("click", function (ev) {
      root.L.popup().setLatLng(ev.latlng).setContent(pointMenu(ev.latlng, tr("map.thisPoint"))).openOn(map);
    });
    showRoads(data);
    overlay = root.L.layerGroup().addTo(map);
  }

  /** Route geometry in travel order. */
  function routeLatLngs(data, edgeById, route) {
    var pts = [];
    route.edges.forEach(function (eid, i) {
      var e = edgeById[eid];
      var ll = latLngs(e.geom);
      if (e.from !== route.nodes[i]) ll.reverse();
      pts = pts.concat(pts.length ? ll.slice(1) : ll);
    });
    return pts;
  }

  function divIcon(cls, html, size) {
    return root.L.divIcon({ className: "mk " + cls, html: html || "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  }

  /**
   * opts: { data, levels, routes, focusedSig, origin, destination,
   *         selectedEdgeId, nodeById, edgeById, blackspots, fitKey }
   */
  function render(container, opts) {
    if (!root.L) return false;
    if (!map) {
      init(container, opts.data);
      var pending = liveUrl;
      liveUrl = null;
      setLiveOverlay(pending);
    } else if (opts.data !== dataRef) {
      // A different area was loaded: draw its roads instead.
      map.closePopup();
      showRoads(opts.data);
    }
    var data = opts.data;

    // Road colours: only restyle roads whose level changed.
    Object.keys(roadLines).forEach(function (id) {
      var lv = opts.levels[id] || "light";
      if (drawnLevels[id] === lv) return;
      drawnLevels[id] = lv;
      roadLines[id].setStyle(roadStyle(roadType[id], lv));
    });

    overlay.clearLayers();
    var routes = opts.routes || [];
    var focusingAlt = routes.length > 1 && routes[0].signature !== opts.focusedSig;
    var bounds = [];

    if (opts.selectedEdgeId && opts.edgeById[opts.selectedEdgeId] && opts.edgeById[opts.selectedEdgeId].geom) {
      var sel = opts.edgeById[opts.selectedEdgeId];
      root.L.polyline(latLngs(sel.geom), { color: "#FFFFFF", weight: 12, opacity: 0.9, interactive: false }).addTo(overlay);
      root.L.polyline(latLngs(sel.geom), {
        color: TRAFFIC_COLORS[opts.levels[sel.id] || "light"], weight: 6, interactive: false
      }).addTo(overlay);
    }

    // Alternatives first, then the recommended route on top.
    routes.forEach(function (r, i) {
      if (i === 0 || !ALT_STYLES[i]) return;
      var s = ALT_STYLES[i];
      var focused = r.signature === opts.focusedSig;
      var ll = routeLatLngs(data, opts.edgeById, r);
      bounds = bounds.concat(ll);
      root.L.polyline(ll, {
        color: s.color, weight: focused ? s.weight + 2 : s.weight, dashArray: s.dashArray,
        lineCap: s.lineCap || "butt", opacity: focusingAlt && !focused ? 0.45 : 0.95, interactive: false
      }).addTo(overlay);
    });
    if (routes.length) {
      var ll0 = routeLatLngs(data, opts.edgeById, routes[0]);
      bounds = bounds.concat(ll0);
      root.L.polyline(ll0, { color: NAVY, weight: 11, opacity: focusingAlt ? 0.25 : 0.55, interactive: false }).addTo(overlay);
      root.L.polyline(ll0, { color: CYAN, weight: 7, opacity: focusingAlt ? 0.45 : 1, interactive: false }).addTo(overlay);
    }

    // Hazard markers along the route being inspected (one per road and hazard).
    var focused = routes.filter(function (r) { return r.signature === opts.focusedSig; })[0] || routes[0];
    if (focused) {
      var seen = {};
      focused.segments.forEach(function (s) {
        var e = opts.edgeById[s.edgeId];
        s.hazards.forEach(function (h) {
          var key = h.id + "|" + s.roadName;
          if (seen[key] || !e.geom) return;
          seen[key] = true;
          var ll = latLngs(e.geom);
          var mid = ll[Math.floor(ll.length / 2)];
          root.L.marker(mid, { icon: divIcon("mk-hazard" + (h.id === "blackspot" ? " is-blackspot" : ""), "!", 20), keyboard: false })
            .bindTooltip(tr("map.tipHazard", { hazard: api.hazardLabel ? api.hazardLabel(h.id) : h.label, road: roadName(e) }))
            .addTo(overlay);
        });
      });
    }

    // Live incidents from TomTom: the affected stretch and a warning marker.
    (opts.incidents || []).forEach(function (inc) {
      if (!inc.edges.length) return;
      var ll = inc.coords.map(function (c) { return [c.lat, c.lon]; });
      var severe = inc.level === "closed" || inc.level === "heavy";
      if (ll.length > 1) {
        root.L.polyline(ll, {
          color: severe ? "#C62828" : "#E3A11B", weight: 7, opacity: 0.85,
          dashArray: inc.level === "closed" ? "8 6" : null, interactive: false
        }).addTo(overlay);
      }
      var mid = ll[Math.floor(ll.length / 2)];
      root.L.marker(mid, {
        icon: divIcon("mk-incident inc-" + inc.category + (severe ? " is-severe" : ""), INCIDENT_ICONS[inc.category] || "!", 26),
        zIndexOffset: 900,
        keyboard: false
      }).bindTooltip(opts.incidentTip ? opts.incidentTip(inc) : inc.category).addTo(overlay);
    });

    // Problems reported by people, with "still there" / "cleared" buttons.
    (opts.reports || []).forEach(function (r) {
      var info = opts.reportInfo ? opts.reportInfo(r) : { title: r.type, detail: "", canVote: false };
      var marker = root.L.marker([r.lat, r.lon], {
        icon: divIcon("mk-report rp-" + r.type, REPORT_ICONS[r.type] || "?", 26),
        zIndexOffset: 950,
        keyboard: false
      }).bindTooltip(info.title);
      marker.on("click", function (ev) {
        root.L.DomEvent.stopPropagation(ev);
        var items = [{ label: info.detail }];
        if (info.canVote) {
          items.push({ text: tr("report.vote.confirm"), className: "is-confirm", run: function () { act("vote", { id: r.id, kind: "confirm" }); } });
          items.push({ text: tr("report.vote.clear"), className: "is-clear", run: function () { act("vote", { id: r.id, kind: "clear" }); } });
        } else if (info.votedText) {
          items.push({ label: info.votedText });
        }
        root.L.popup().setLatLng([r.lat, r.lon]).setContent(menu(info.title, items)).openOn(map);
      });
      marker.addTo(overlay);
    });

    // Accident black spots from js/blackspots.js.
    (opts.blackspots || []).forEach(function (b) {
      root.L.circle([b.lat, b.lon], { radius: b.radiusMetres || 100, color: "#DD4545", weight: 2, fillOpacity: 0.12, interactive: false })
        .addTo(overlay);
      root.L.marker([b.lat, b.lon], { icon: divIcon("mk-hazard is-blackspot", "!", 22), keyboard: false })
        .bindTooltip(tr("map.tipBlackspot", { name: b.name }))
        .addTo(overlay);
    });

    // Hospitals.
    data.NODES.forEach(function (n) {
      if (n.kind !== "hospital") return;
      var label = opts.placeName ? opts.placeName(n) : n.name;
      root.L.marker([n.lat, n.lon], {
        icon: divIcon("mk-hospital" + (n.emergency === false ? " is-special" : ""), "H", 18),
        title: label
      }).bindTooltip(label).on("click", function (ev) {
        root.L.DomEvent.stopPropagation(ev);
        root.L.popup().setLatLng([n.lat, n.lon]).setContent(menu(label, [
          { text: tr("map.goHere"), run: function () { act("choose-destination", n.id); } },
          { text: tr("map.startHere"), run: function () { act("choose-start", n.id); } }
        ])).openOn(map);
      }).addTo(overlay);
    });

    // Start and destination.
    [["origin", "mk-start"], ["destination", "mk-end"]].forEach(function (pair) {
      var n = opts.nodeById[opts[pair[0]]];
      if (!n) return;
      bounds.push([n.lat, n.lon]);
      var label = opts.placeName ? opts.placeName(n) : n.name;
      root.L.marker([n.lat, n.lon], { icon: divIcon(pair[1], "", 22), zIndexOffset: 1000, title: label })
        .bindTooltip(tr(pair[0] === "origin" ? "map.tipStart" : "map.tipDestination", { name: label }))
        .addTo(overlay);
    });

    if (opts.fitKey && opts.fitKey !== lastFitKey && bounds.length) {
      lastFitKey = opts.fitKey;
      map.fitBounds(root.L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 17, animate: false });
    }
    return true;
  }

  /** Shows TomTom's live traffic tiles over the map (url) or removes them (null). */
  function setLiveOverlay(url) {
    if (url === liveUrl) return;
    liveUrl = url;
    if (!map) return;
    if (liveLayer) {
      map.removeLayer(liveLayer);
      liveLayer = null;
    }
    if (url) {
      liveLayer = root.L.tileLayer(url, {
        maxZoom: 19, opacity: 0.75, zIndex: 5,
        attribution: 'Live traffic &copy; <a href="https://www.tomtom.com/">TomTom</a>'
      }).addTo(map);
    }
  }

  /** Centres the map on a point (e.g. an incident chosen from the list). */
  function focusOn(lat, lon) {
    if (map) map.setView([lat, lon], 17, { animate: false });
  }

  api.render = render;
  api.focusOn = focusOn;
  api.setLiveOverlay = setLiveOverlay;
  api.invalidate = function () {
    if (map) map.invalidateSize();
  };
  /** Current view, for tests: { lat, lon, zoom } or null before the map exists. */
  api.view = function () {
    if (!map) return null;
    var c = map.getCenter();
    return { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
  };
  api.available = function () {
    return !!root.L;
  };
  root.RealMapView = api;
})(typeof self !== "undefined" ? self : this);
