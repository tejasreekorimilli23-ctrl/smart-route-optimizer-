/*
 * UI controller. Reads user input, asks RouteEngine for results, and renders
 * the planner, map, comparison cards and calculation breakdown.
 * All route numbers shown on the page come straight from RouteEngine output.
 *
 * Two modes share everything except the data and the map drawing:
 *  - "real": the real road network of the area (js/real-network-data.js,
 *    from OpenStreetMap) on a Leaflet map, with GPS and map clicks;
 *  - "demo": the small offline sample town on a schematic SVG map.
 */
(function () {
  "use strict";

  var E = window.RouteEngine;
  var G = window.GeoTools;
  var DATASETS = { demo: window.TrafficData, real: window.RealTrafficData };
  var VIEWS = { demo: window.MapView, real: window.RealMapView };

  function $(id) {
    return document.getElementById(id);
  }

  if (!E || !DATASETS.demo || !VIEWS.demo) {
    var fatal = $("app-error");
    if (fatal) {
      fatal.textContent = "The route planner could not load its scripts. Keep the js folder next to index.html, then reload the page.";
      fatal.hidden = false;
    }
    return;
  }

  var realAvailable = !!(DATASETS.real && G && VIEWS.real && VIEWS.real.available());
  var BLACKSPOTS = (Array.isArray(window.BLACKSPOTS) ? window.BLACKSPOTS : []).filter(function (b) {
    return b && typeof b.lat === "number" && typeof b.lon === "number" && b.name;
  });
  if (realAvailable) G.applyBlackspots(DATASETS.real, BLACKSPOTS);

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var PIN_IDS = { start: "u-start", destination: "u-dest" };

  // Per-mode data, set by setMode().
  var mode;
  var D;
  var M;
  var nodeById;
  var edgeById;
  var NODES_SORTED;
  var EDGES_SORTED;
  var DEFAULT_ROAD;
  var pins = {}; // role -> { node, edges } for GPS / map-click locations (real mode)
  var routing = null; // cached { data } including pins
  var state;
  var fitCounter = 0;
  var hourTimer = null;

  var els = {
    modeOptions: $("mode-options"),
    modeBadgeText: $("mode-badge-text"),
    form: $("route-form"),
    origin: $("origin"),
    destination: $("destination"),
    swap: $("swap"),
    locate: $("locate"),
    locateStatus: $("locate-status"),
    priorityOptions: $("priority-options"),
    emergency: $("emergency"),
    formError: $("form-error"),
    plannerNote: $("planner-note"),
    hour: $("hour"),
    hourLabel: $("hour-label"),
    now: $("now"),
    scenarioSet: $("scenario-set"),
    scenarioOptions: $("scenario-options"),
    scenarioDesc: $("scenario-desc"),
    trafficNote: $("traffic-note"),
    reset: $("reset"),
    map: $("map"),
    demoMap: $("demo-map"),
    realMap: $("real-map"),
    mapPanel: document.querySelector(".map-panel"),
    mapSummary: $("map-summary"),
    mapNote: $("map-note"),
    changeNotice: $("change-notice"),
    roadSelect: $("road-select"),
    roadPicked: $("road-picked"),
    levelOptions: $("level-options"),
    resultsBody: $("results-body"),
    calc: $("calc"),
    calcBody: $("calc-body")
  };

  // ---------- units and formatting ----------

  function fT(units) { return E.formatTime(D, units); }
  function fD(units) { return E.formatDistance(D, units); }
  function fR(units) { return E.formatRisk(D, units); }

  function isReal() {
    return mode === "real";
  }

  // ---------- data including pinned points ----------

  function pinList() {
    return Object.keys(pins).map(function (k) { return pins[k]; });
  }

  /** The current data plus any GPS / map-click locations. */
  function routeData() {
    var list = pinList();
    if (!list.length) return D;
    if (!routing) {
      routing = Object.assign({}, D, {
        NODES: D.NODES.concat(list.map(function (p) { return p.node; })),
        EDGES: D.EDGES.concat([].concat.apply([], list.map(function (p) { return p.edges; })))
      });
    }
    return routing;
  }

  /** Traffic levels, with pinned connector roads sharing their road's level. */
  function routeLevels() {
    var list = pinList();
    if (!list.length) return state.levels;
    var lv = Object.assign({}, state.levels);
    list.forEach(function (p) {
      p.edges.forEach(function (e) { lv[e.id] = state.levels[e.parentId] || "light"; });
    });
    return lv;
  }

  function indexData() {
    var data = routeData();
    nodeById = {};
    edgeById = {};
    data.NODES.forEach(function (n) { nodeById[n.id] = n; });
    data.EDGES.forEach(function (e) { edgeById[e.id] = e; });
  }

  function byName(a, b) {
    return a.name.localeCompare(b.name);
  }

  function currentHour() {
    var h = new Date().getHours();
    return Math.min(D.DAY_END_HOUR, Math.max(D.DAY_START_HOUR, h));
  }

  function initialState() {
    var hour = isReal() ? currentHour() : D.DEFAULTS.hour;
    var levels = E.levelsForHour(D, hour) || E.levelsForScenario(D, D.DEFAULTS.scenarioId);
    return {
      scenarioId: matchScenario(levels),
      hour: E.levelsForHour(D, hour) ? hour : null, // null when traffic is not set by the time slider
      levels: levels,
      priority: D.DEFAULTS.priority, // "fastest" or "safest"
      query: null, // { origin, destination, emergency } of the last successful search
      result: null, // RouteEngine output for that query
      focusedSig: null, // route shown in detail on the map and in the breakdown
      stale: false, // selection changed since the last search
      selectedEdgeId: DEFAULT_ROAD,
      notice: null,
      fitKey: null
    };
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function scenarioById(id) {
    for (var i = 0; i < D.SCENARIOS.length; i++) if (D.SCENARIOS[i].id === id) return D.SCENARIOS[i];
    return null;
  }

  /** If hand-edited levels happen to equal a preset, treat them as that preset. */
  function matchScenario(levels) {
    for (var i = 0; i < D.SCENARIOS.length; i++) {
      var preset = E.levelsForScenario(D, D.SCENARIOS[i].id);
      var same = D.EDGES.every(function (e) { return preset[e.id] === levels[e.id]; });
      if (same) return D.SCENARIOS[i].id;
    }
    return "custom";
  }

  /** 8 -> "8:00 AM", 12 -> "12:00 PM", 22 -> "10:00 PM". */
  function hourText(hour) {
    var h12 = hour % 12 === 0 ? 12 : hour % 12;
    return h12 + ":00 " + (hour < 12 ? "AM" : "PM");
  }

  function conditionsPhrase() {
    var est = isReal() ? "estimated " : "";
    if (state.hour !== null) {
      return hourText(state.hour) + " (" + E.bandForHour(D, state.hour).name.toLowerCase() + ") " + est + "traffic";
    }
    var sc = scenarioById(state.scenarioId);
    return sc ? sc.name.toLowerCase() + " traffic" : "your custom traffic conditions";
  }

  function priorityWord() {
    return state.priority === "safest" ? "safest" : "fastest";
  }

  /** The headline figure for a route under the current priority. */
  function keyFigure(r) {
    return state.priority === "safest"
      ? "risk score " + fR(r.riskUnits) + ", " + fT(r.timeUnits) + " min"
      : fT(r.timeUnits) + " min";
  }

  /**
   * One sentence comparing the recommendation with the best route under the
   * other priority, e.g. what the safer route costs in time.
   */
  function tradeoffText(res) {
    var rec = res.recommended;
    var other = res.routes.filter(function (r) {
      return state.priority === "safest" ? r.isFastest : r.isSafest;
    })[0];
    if (!other || other.signature === rec.signature) {
      return "It is also the " + (state.priority === "safest" ? "fastest" : "safest") + " route.";
    }
    var risk = " (risk score " + fR(other.riskUnits) + " vs " + fR(rec.riskUnits) + ")";
    if (state.priority === "safest") {
      var saves = -other.extraTimeUnits;
      return "The fastest route, " + routeLabel(other) + ", " +
        (saves > 0 ? "would save " + fT(saves) + " min" : "takes the same time") +
        " but has more road hazards" + risk + ".";
    }
    var extra = other.extraTimeUnits;
    return "The safest route, " + routeLabel(other) + ", " +
      (extra > 0 ? "takes " + fT(extra) + " min longer" : "takes the same time") +
      " but avoids more road hazards" + risk + ".";
  }

  function routeLabel(r) {
    return "Route " + r.rank + " " + r.name;
  }

  function swatchSvg(rank) {
    if (rank === 1) {
      return '<svg class="route-swatch" width="34" height="14" aria-hidden="true"><line x1="3" y1="7" x2="31" y2="7" stroke="#3FD8EA" stroke-width="12" stroke-linecap="round"/></svg>';
    }
    if (rank === 2) {
      return '<svg class="route-swatch alt" width="34" height="14" aria-hidden="true"><line x1="3" y1="7" x2="31" y2="7" stroke="currentColor" stroke-width="3.5" stroke-dasharray="9 5"/></svg>';
    }
    return '<svg class="route-swatch alt" width="34" height="14" aria-hidden="true"><line x1="4" y1="7" x2="31" y2="7" stroke="currentColor" stroke-width="5" stroke-dasharray="0.1 8" stroke-linecap="round"/></svg>';
  }

  // ---------- build controls ----------

  function fillLocationSelect(sel, placeholder) {
    var keep = sel.value;
    sel.innerHTML = "";
    sel.add(new Option(placeholder, ""));
    if (!isReal()) {
      NODES_SORTED.forEach(function (n) { sel.add(new Option(n.name, n.id)); });
    } else {
      var list = pinList();
      if (list.length) {
        var g0 = document.createElement("optgroup");
        g0.label = "Your points";
        list.forEach(function (p) { g0.appendChild(new Option(p.node.name, p.node.id)); });
        sel.appendChild(g0);
      }
      D.PLACE_CATEGORIES.forEach(function (cat) {
        var items = NODES_SORTED.filter(function (n) { return n.category === cat; });
        if (!items.length) return;
        var g = document.createElement("optgroup");
        g.label = cat;
        items.forEach(function (n) { g.appendChild(new Option(n.name, n.id)); });
        sel.appendChild(g);
      });
    }
    if (keep && nodeById[keep]) sel.value = keep;
  }

  function fillLocationSelects() {
    fillLocationSelect(els.origin, isReal() ? "Choose a place, or use your location" : "Choose a starting point");
    fillLocationSelect(els.destination, "Choose a destination");
  }

  function buildControls() {
    els.origin.value = "";
    els.destination.value = "";
    fillLocationSelects();
    els.origin.value = D.DEFAULTS.origin || "";
    els.destination.value = D.DEFAULTS.destination || "";

    els.scenarioOptions.innerHTML = D.SCENARIOS.map(function (s) {
      return '<label class="tile"><input type="radio" name="scenario" value="' + esc(s.id) + '">' +
        '<span class="tile-body">' + esc(s.name) + "</span></label>";
    }).join("");
    els.scenarioSet.hidden = !D.SCENARIOS.length;

    els.roadSelect.innerHTML = "";
    if (!isReal()) EDGES_SORTED.forEach(function (e) { els.roadSelect.add(new Option(e.name, e.id)); });

    els.levelOptions.innerHTML = D.CONGESTION_ORDER.map(function (id) {
      return '<label class="seg"><input type="radio" name="road-level" value="' + esc(id) + '">' +
        '<span class="seg-body"><span class="seg-dot ' + esc(id) + '" aria-hidden="true"></span>' +
        esc(D.CONGESTION_LEVELS[id].label) + "</span></label>";
    }).join("");

    els.hour.min = D.DAY_START_HOUR;
    els.hour.max = D.DAY_END_HOUR;
  }

  function syncControls() {
    Array.prototype.forEach.call(els.modeOptions.querySelectorAll("input"), function (input) {
      input.checked = input.value === mode;
    });
    Array.prototype.forEach.call(els.priorityOptions.querySelectorAll("input"), function (input) {
      input.checked = input.value === state.priority;
    });
    Array.prototype.forEach.call(els.scenarioOptions.querySelectorAll("input"), function (input) {
      input.checked = input.value === state.scenarioId;
    });
    var band = state.hour !== null ? E.bandForHour(D, state.hour) : null;
    if (band) {
      els.hour.value = state.hour;
      els.hourLabel.textContent = hourText(state.hour) + " · " + band.name;
      els.hour.setAttribute("aria-valuetext", hourText(state.hour) + ", " + band.name);
    } else {
      els.hourLabel.textContent = "Not in use";
      els.hour.setAttribute("aria-valuetext", "Not in use: traffic set by a scenario or by hand");
    }
    els.hour.classList.toggle("is-inactive", !band);
    var sc = scenarioById(state.scenarioId);
    els.scenarioDesc.textContent = band
      ? band.description
      : sc
        ? sc.description
        : "Custom conditions: you changed individual roads. Pick a time" + (D.SCENARIOS.length ? " or a scenario" : "") + " to start again.";
    if (isReal()) {
      var e = edgeById[state.selectedEdgeId];
      els.roadPicked.textContent = e ? e.name + " (" + D.CONGESTION_LEVELS[state.levels[e.id] || "light"].label.toLowerCase() + " traffic)" : "Click a road on the map to choose it.";
    } else {
      els.roadSelect.value = state.selectedEdgeId;
    }
    var level = state.selectedEdgeId ? state.levels[state.selectedEdgeId] : null;
    Array.prototype.forEach.call(els.levelOptions.querySelectorAll("input"), function (input) {
      input.checked = input.value === level;
      input.disabled = !state.selectedEdgeId;
    });
  }

  // ---------- modes ----------

  var MODE_TEXT = {
    demo: {
      badge: "Demo mode: traffic is simulated, not live",
      planner: "Traffic in this demo is simulated from fixed sample values. It is not live traffic information.",
      traffic: "To change a single road, click it on the map or use the road controls under the map.",
      map: "Schematic diagram: positions, road lengths and names are illustrative, not a real street map. Do not use it for navigation."
    },
    real: {
      badge: "Real roads from OpenStreetMap · traffic estimated, not live",
      planner: "Tip: click anywhere on the map to start or go there. Traffic is estimated from the time of day and road type; it is not live.",
      traffic: "Roads closed or jammed right now? Click the road on the map and set its traffic.",
      map: "Map data © OpenStreetMap contributors. Roads and places can have gaps or errors: always follow road signs, signals and the traffic police."
    }
  };

  function setMode(next) {
    if (next === "real" && !realAvailable) next = "demo";
    mode = next;
    try { window.localStorage.setItem("route-mode", mode); } catch (err) { /* private mode: ignore */ }
    D = DATASETS[mode];
    M = VIEWS[mode];
    pins = {};
    routing = null;
    indexData();
    NODES_SORTED = D.NODES.filter(function (n) { return !isReal() || n.category; }).sort(byName);
    EDGES_SORTED = isReal() ? [] : D.EDGES.slice().sort(byName);
    DEFAULT_ROAD = isReal() ? null : edgeById.e08 ? "e08" : EDGES_SORTED[0].id; // MG Road (east): good demo road

    document.body.classList.toggle("is-real", isReal());
    document.body.classList.toggle("is-demo", !isReal());
    els.realMap.hidden = !isReal();
    els.demoMap.hidden = isReal();
    var t = MODE_TEXT[mode];
    els.modeBadgeText.textContent = isReal() ? "Real roads of " + D.AREA.name + " (OpenStreetMap) · traffic estimated, not live" : t.badge;
    els.plannerNote.textContent = t.planner;
    els.trafficNote.textContent = t.traffic;
    els.mapNote.textContent = t.map;
    els.locateStatus.textContent = "";

    state = initialState();
    buildControls();
    clearFormError();
    if (els.calc) els.calc.open = false;
    renderAll();
    if (isReal()) setTimeout(function () { VIEWS.real.invalidate(); }, 0);
  }

  // ---------- form validation ----------

  function showFormError(message, field) {
    els.formError.textContent = message;
    els.formError.hidden = false;
    [els.origin, els.destination].forEach(function (s) { s.removeAttribute("aria-invalid"); });
    if (field) {
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }

  function clearFormError() {
    els.formError.hidden = true;
    els.formError.textContent = "";
    els.origin.removeAttribute("aria-invalid");
    els.destination.removeAttribute("aria-invalid");
  }

  // ---------- actions ----------

  function compute(query) {
    return query.emergency
      ? E.findEmergencyRoute(routeData(), routeLevels(), query.origin)
      : E.findRoutes(routeData(), routeLevels(), query.origin, query.destination, { priority: state.priority });
  }

  function showResult(query, res) {
    clearFormError();
    state.query = query;
    state.result = res;
    state.stale = false;
    state.notice = null;
    state.focusedSig = res.ok ? res.recommended.signature : null;
    state.fitKey = "fit" + ++fitCounter;
    renderAll();

    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
      els.mapPanel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  }

  function runSearch() {
    var query = { origin: els.origin.value, destination: els.destination.value, emergency: false };
    var res = compute(query);
    if (!res.ok && res.code !== "UNREACHABLE") {
      showFormError(res.message, res.code === "MISSING_ORIGIN" ? els.origin : els.destination);
      return;
    }
    showResult(query, res);
  }

  /** Fastest route from the chosen Start to the nearest hospital. */
  function runEmergency() {
    state.priority = "fastest";
    var query = { origin: els.origin.value, destination: null, emergency: true };
    var res = compute(query);
    if (!res.ok && res.code !== "UNREACHABLE") {
      syncControls();
      showFormError(res.message, els.origin);
      return;
    }
    if (res.ok) {
      query.destination = res.hospital.id;
      els.destination.value = res.hospital.id;
    }
    showResult(query, res);
  }

  function buildNotice(prev, res, cause) {
    if (!res.ok) {
      return { kind: "warn", text: cause + " " + res.message };
    }
    var rec = res.recommended;
    var word = priorityWord();
    if (!prev || !prev.ok) {
      return {
        kind: "changed",
        text: cause + " A route is available again: the route " + rec.name + " takes " + fT(rec.timeUnits) + " min."
      };
    }
    var old = prev.recommended;
    if (old.signature === rec.signature) {
      var was = old.timeUnits !== rec.timeUnits ? " (was " + fT(old.timeUnits) + " min)" : "";
      return {
        kind: "same",
        text: cause + " Recommendation unchanged: the route " + rec.name + " is still " + word + " at " +
          keyFigure(rec) + was + "."
      };
    }
    var oldNow = E.evaluatePath(routeData(), routeLevels(), old.edges);
    var oldPart = oldNow.closed
      ? "The previous route, " + old.name + ", now uses a closed road."
      : "The previous route, " + old.name + ", would now take " + fT(oldNow.timeUnits) + " min.";
    return {
      kind: "changed",
      text: cause + " Recommendation changed: the route " + rec.name + " is now " + word + " at " +
        keyFigure(rec) + ". " + oldPart
    };
  }

  /**
   * Recalculate the current query, if any, after conditions changed.
   * makeNotice(prev, res, cause) builds the notice; defaults to buildNotice.
   */
  function recalc(cause, makeNotice) {
    if (state.query) {
      var prev = state.result;
      var res = compute(state.query);
      if (res.ok && res.emergency) {
        state.query.destination = res.hospital.id;
        els.destination.value = res.hospital.id;
      }
      state.notice = (makeNotice || buildNotice)(prev, res, cause);
      state.result = res;
      if (res.ok) {
        // If the user was looking at the recommendation, follow the new one.
        // Keep an alternative in focus only if they chose it and it still exists.
        var wasOnRecommended = !prev || !prev.ok || state.focusedSig === prev.recommended.signature;
        var stillThere = res.routes.some(function (r) { return r.signature === state.focusedSig; });
        if (wasOnRecommended || !stillThere) state.focusedSig = res.recommended.signature;
      } else {
        state.focusedSig = null;
      }
    }
    renderAll();
  }

  /** Apply new traffic levels (hour is null unless set by the time slider). */
  function applyTraffic(levels, hour, cause) {
    state.levels = E.normalizeLevels(D, levels);
    state.hour = hour;
    state.scenarioId = matchScenario(state.levels);
    recalc(cause);
  }

  function setHour(hour) {
    var levels = E.levelsForHour(D, hour);
    if (!levels) return;
    applyTraffic(levels, hour, hourText(hour) + " traffic (" + E.bandForHour(D, hour).name.toLowerCase() + ") applied.");
  }

  function setPriority(priority) {
    if (!E.PRIORITIES[priority] || priority === state.priority) return;
    state.priority = priority;
    // An emergency is always the fastest route; choosing "safest" turns it
    // into an ordinary search to the same hospital.
    if (state.query && state.query.emergency && priority === "safest") state.query.emergency = false;
    // Traffic has not changed, so explain the trade-off rather than re-timing
    // the previous route.
    recalc("Now recommending the " + priority + " route.", function (prev, res, cause) {
      if (!res.ok) return buildNotice(prev, res, cause);
      var rec = res.recommended;
      var kind = prev && prev.ok && prev.recommended.signature === rec.signature ? "same" : "changed";
      var text = cause + " " + routeLabel(rec) + ": " + keyFigure(rec) + ".";
      if (res.routes.length > 1) text += " " + tradeoffText(res);
      return { kind: kind, text: text };
    });
  }

  function setRoadLevel(edgeId, level) {
    if (!D.CONGESTION_LEVELS[level] || state.levels[edgeId] === undefined) return;
    state.selectedEdgeId = edgeId;
    var levels = Object.assign({}, state.levels);
    var before = levels[edgeId];
    levels[edgeId] = level;
    var name = edgeById[edgeId].name;
    var cause;
    if (level === "closed") cause = name + " closed.";
    else if (before === "closed") cause = name + " reopened with " + level + " traffic.";
    else cause = name + " set to " + level + " traffic.";
    applyTraffic(levels, null, cause);
  }

  function reopenClosedRoads() {
    var levels = {};
    var count = 0;
    Object.keys(state.levels).forEach(function (k) {
      if (state.levels[k] === "closed") count++;
      levels[k] = state.levels[k] === "closed" ? "light" : state.levels[k];
    });
    applyTraffic(levels, null, count === 1 ? "Closed road reopened." : "Closed roads reopened.");
  }

  function resetDemo() {
    pins = {};
    routing = null;
    indexData();
    state = initialState();
    buildControls();
    clearFormError();
    els.locateStatus.textContent = "";
    if (els.calc) els.calc.open = false;
    renderAll();
  }

  /**
   * Pins a GPS position or map click as the start or destination.
   * Returns false (and explains why) if it is too far from any road.
   */
  function setPin(role, lat, lon, label) {
    var id = PIN_IDS[role];
    var pinned = G.pinToRoad(D, id, label, lat, lon);
    if (!pinned) {
      showFormError("That point is more than " + G.MAX_PIN_METRES + " m from any road on the map of " + D.AREA.name +
        ". The real map only covers this area.", role === "start" ? els.origin : els.destination);
      return false;
    }
    if (label === "Map point") pinned.node.name = "Point on " + pinned.road.name;
    pins[role] = pinned;
    routing = null;
    indexData();
    fillLocationSelects();
    (role === "start" ? els.origin : els.destination).value = id;
    return true;
  }

  /** Runs a search straight away when both ends are chosen (map actions). */
  function searchIfReady() {
    clearFormError();
    if (els.origin.value && els.destination.value && els.origin.value !== els.destination.value) {
      runSearch();
    } else {
      state.stale = !!state.query;
      renderAll();
    }
  }

  function locateMe() {
    if (!navigator.geolocation) {
      els.locateStatus.textContent = "This browser cannot share your location.";
      return;
    }
    els.locateStatus.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(function (pos) {
      var c = pos.coords;
      if (setPin("start", c.latitude, c.longitude, "My location")) {
        els.locateStatus.textContent = "Start set to your location (accurate to about " + Math.round(c.accuracy) + " m).";
        searchIfReady();
      } else {
        els.locateStatus.textContent = "";
      }
    }, function (err) {
      els.locateStatus.textContent = err.code === 1
        ? "Location permission was refused. Allow it in the browser, or pick a place from the list."
        : "Could not get your location. Pick a place from the list, or click the map.";
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function onMapAction(action, payload) {
    if (!isReal()) return;
    if (action === "set-start" || action === "set-destination") {
      var role = action === "set-start" ? "start" : "destination";
      if (setPin(role, payload.lat, payload.lng, "Map point")) searchIfReady();
    } else if (action === "choose-start" || action === "choose-destination") {
      (action === "choose-start" ? els.origin : els.destination).value = payload;
      searchIfReady();
    } else if (action === "select-road") {
      state.selectedEdgeId = payload;
      syncControls();
      renderMap();
    } else if (action === "set-level") {
      setRoadLevel(payload.edgeId, payload.level);
    }
  }

  // ---------- rendering ----------

  function renderMap() {
    var res = state.result;
    var routes = res && res.ok ? res.routes : [];
    var origin = state.query ? state.query.origin : els.origin.value || null;
    var destination = state.query ? state.query.destination : els.destination.value || null;
    M.render(isReal() ? els.realMap : els.map, {
      data: D,
      levels: routeLevels(),
      routes: routes,
      focusedSig: state.focusedSig,
      origin: origin,
      destination: destination,
      selectedEdgeId: state.selectedEdgeId,
      nodeById: nodeById,
      edgeById: edgeById,
      blackspots: BLACKSPOTS,
      fitKey: state.fitKey
    });
  }

  function renderSummary() {
    var res = state.result;
    var html;
    if (!state.query || !res) {
      html = "Press <strong>Find Best Route</strong> to compare routes.";
    } else if (!res.ok) {
      html = "No route to show under the current conditions.";
    } else {
      var r = res.recommended;
      html = res.emergency
        ? '<span class="emg-flag">Emergency</span> <strong>' + esc(routeLabel(r)) + "</strong> to " + esc(res.hospital.name) +
          ", " + fT(r.timeUnits) + " min for " + fD(r.distanceUnits) + " km"
        : "Recommended (" + priorityWord() + "): <strong>" + esc(routeLabel(r)) + "</strong>, " + fT(r.timeUnits) +
          " min for " + fD(r.distanceUnits) + " km";
    }
    if (state.stale) html += ' <span class="stale-flag">Out of date: selection changed</span>';
    els.mapSummary.innerHTML = html;
  }

  function renderNotice() {
    var n = state.notice;
    if (!n) {
      els.changeNotice.hidden = true;
      els.changeNotice.textContent = "";
      return;
    }
    els.changeNotice.hidden = false;
    els.changeNotice.className = "change-notice is-" + n.kind;
    els.changeNotice.textContent = n.text;
    if (!reduceMotion) {
      els.changeNotice.classList.remove("flash");
      void els.changeNotice.offsetWidth; // restart the one-shot highlight
      els.changeNotice.classList.add("flash");
    }
  }

  function comparisonText(r, res) {
    var safest = res.priority === "safest";
    if (r.isRecommended) {
      var next = res.routes[1];
      if (!next) return "Only route available";
      if (safest) {
        if (next.extraRiskUnits === 0) return "Ties with Route 2 on risk and is quicker";
        return "Safest: risk score " + fR(next.extraRiskUnits) + " lower than Route 2";
      }
      if (next.extraTimeUnits === 0) return "Ties with Route 2 on time and is shorter";
      return "Fastest: saves " + fT(next.extraTimeUnits) + " min over Route 2";
    }
    var t = r.extraTimeUnits;
    var timePart = t === 0 ? "Same time as Route 1" : t > 0 ? fT(t) + " min slower" : fT(-t) + " min faster";
    var d = r.extraDistanceUnits;
    var distPart = d > 0 ? fD(d) + " km longer" : d < 0 ? fD(-d) + " km shorter" : "same distance";
    if (safest) {
      var k = r.extraRiskUnits;
      var riskPart = k === 0 ? "same risk score" : "risk score " + fR(k) + " higher";
      return riskPart + ", " + timePart.charAt(0).toLowerCase() + timePart.slice(1) + ", " + distPart;
    }
    return timePart + ", " + distPart;
  }

  function hazardList(r) {
    if (!r.hazards.length) return '<p class="hazards none">No marked road hazards on this route.</p>';
    var seen = {};
    var items = r.hazards.filter(function (h) {
      var key = h.label + "|" + h.roadName;
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    return '<ul class="hazards" aria-label="Road hazards on ' + esc(routeLabel(r)) + '">' +
      items.map(function (h) {
        return '<li class="hz-' + esc(h.id) + '"><strong>' + esc(h.label) + "</strong> on " + esc(h.roadName) + "</li>";
      }).join("") + "</ul>";
  }

  function trafficBar(r) {
    var total = r.distanceUnits;
    var parts = ["light", "moderate", "heavy"].filter(function (k) { return r.levelDistanceUnits[k] > 0; });
    var label = parts.map(function (k) {
      return fD(r.levelDistanceUnits[k]) + " km " + D.CONGESTION_LEVELS[k].label.toLowerCase();
    }).join(", ");
    return '<div class="traffic-bar" role="img" aria-label="Traffic along this route: ' + esc(label) + '">' +
      parts.map(function (k) {
        var pct = (r.levelDistanceUnits[k] / total) * 100;
        return '<span class="tb ' + k + '" style="width:' + pct.toFixed(2) + '%"></span>';
      }).join("") + "</div>";
  }

  /** Real mode: the roads a route follows, in order, each named once per stretch. */
  function roadSequence(r) {
    var out = [];
    r.segments.forEach(function (s) {
      if (edgeById[s.edgeId] && edgeById[s.edgeId].type === "access") return;
      var name = s.corridor ? s.roadName : "local lanes";
      if (out.length && out[out.length - 1] === name) return;
      out.push(name);
    });
    return out;
  }

  function stopsList(r) {
    var items;
    if (isReal()) {
      var roads = roadSequence(r);
      var shown = roads.length > 9 ? roads.slice(0, 8).concat(["… " + (roads.length - 8) + " more"]) : roads;
      items = [r.nodeNames[0]].concat(shown, [r.nodeNames[r.nodeNames.length - 1]]);
      return '<ol class="stops is-roads" aria-label="Roads along ' + esc(routeLabel(r)) + '">' +
        items.map(function (name, i) {
          return '<li' + (i > 0 && i < items.length - 1 ? ' class="road"' : "") + ">" + esc(name) + "</li>";
        }).join("") + "</ol>";
    }
    items = r.nodeNames;
    return '<ol class="stops" aria-label="Locations along ' + esc(routeLabel(r)) + '">' +
      items.map(function (name) { return "<li>" + esc(name) + "</li>"; }).join("") + "</ol>";
  }

  function routeCard(r, res) {
    var focused = r.signature === state.focusedSig;
    var id = "route-title-" + r.rank;
    var badge = (r.isRecommended ? '<p class="rec-badge">Recommended</p>' : "") +
      (r.isFastest ? '<p class="tag-badge">Fastest</p>' : "") +
      (r.isSafest ? '<p class="tag-badge is-safe">Safest</p>' : "");
    var mapBtnLabel = focused ? "Shown on map" : "Show on map";
    return (
      '<article class="route-card' + (r.isRecommended ? " is-recommended" : "") + (focused ? " is-focused" : "") +
        '" aria-labelledby="' + id + '">' +
        '<div class="route-head">' +
          swatchSvg(r.rank) +
          '<h3 id="' + id + '"><span class="route-num">Route ' + r.rank + '</span> <span class="route-name">' + esc(r.name) + "</span></h3>" +
          badge +
        "</div>" +
        '<dl class="route-metrics">' +
          '<div class="metric metric-time"><dt>Estimated time</dt><dd><span class="num">' + fT(r.timeUnits) + '</span> min</dd></div>' +
          '<div class="metric"><dt>Distance</dt><dd><span class="num">' + fD(r.distanceUnits) + '</span> km</dd></div>' +
          '<div class="metric"><dt>Traffic</dt><dd><span class="chip ' + r.congestion.key + '">' + esc(r.congestion.label) + "</span>" +
            '<span class="sub">+' + fT(r.delayUnits) + " min delay (" + r.delayPercent + "%)</span></dd></div>" +
          '<div class="metric metric-safety"><dt>Safety</dt><dd><span class="chip ' + r.safety.tone + '">' + esc(r.safety.label) + "</span>" +
            '<span class="sub">Risk score ' + fR(r.riskUnits) + "</span></dd></div>" +
          '<div class="metric"><dt>Compared with the best</dt><dd class="cmp">' + esc(comparisonText(r, res)) + "</dd></div>" +
        "</dl>" +
        trafficBar(r) +
        hazardList(r) +
        stopsList(r) +
        '<button type="button" class="map-toggle" data-action="focus" data-sig="' + esc(r.signature) + '" aria-pressed="' + focused + '">' + mapBtnLabel + "</button>" +
      "</article>"
    );
  }

  function emptyStateHtml() {
    var o = nodeById[D.DEFAULTS.origin];
    var d = nodeById[D.DEFAULTS.destination];
    var tip = isReal()
      ? "Choose a start and destination from the lists, press <strong>Use my location</strong>, or click the map. For a quick try, compare " +
        esc(o ? o.name : "two places") + " to " + esc(d ? d.name : "another") + "."
      : "Choose a start and destination, then press Find Best Route. For a quick demo, compare Bus Station to Engineering College, then switch the traffic to Morning rush.";
    return '<div class="empty-state">' +
        '<p class="state-title">No routes yet</p>' +
        "<p>" + tip + "</p>" +
        (o && d ? '<button type="button" class="btn-secondary" data-action="sample">Try the sample route</button>' : "") +
      "</div>";
  }

  function emergencyHtml(res, best) {
    var others = (res.nearestHospitals || []).slice(1);
    var list = others.length
      ? '<p>Other hospitals nearby: ' + others.map(function (h) {
          return '<button type="button" class="link-btn inline" data-action="hospital" data-id="' + esc(h.hospital.id) + '">' +
            esc(h.hospital.name) + "</button> (" + fT(h.timeUnits) + " min)";
        }).join(", ") + ".</p>"
      : "";
    return '<div class="emergency-banner" role="alert">' +
        '<p class="state-title">Emergency route to ' + esc(res.hospital.name) + "</p>" +
        "<p>Fastest route from " + esc(res.origin.name) + ": <strong>" + esc(routeLabel(best)) + "</strong>, about " +
        fT(best.timeUnits) + " min under current traffic. It is the nearest hospital by journey time" +
        (isReal() ? "; check that it can treat the emergency" : "") + ".</p>" + list +
        "<p><strong>Call 108 for an ambulance or 112 for any emergency.</strong> Drive at a safe speed: a crash on the way helps no one.</p>" +
      "</div>";
  }

  function renderResults() {
    var body = els.resultsBody;
    if (!state.query || !state.result) {
      body.innerHTML = emptyStateHtml();
      els.calc.hidden = true;
      return;
    }

    var res = state.result;
    var q = state.query;
    var stale = state.stale
      ? '<p class="stale-banner">These results are for ' + esc(nodeById[q.origin] ? nodeById[q.origin].name : "your earlier start") + " to " +
        esc(q.destination && nodeById[q.destination] ? nodeById[q.destination].name : "the nearest hospital") +
        ". You changed the selection; press Find Best Route to update.</p>"
      : "";

    if (!res.ok) {
      var closed = res.closedRoads && res.closedRoads.length
        ? "<p>Closed right now: <strong>" + res.closedRoads.map(esc).join(", ") + "</strong>.</p>" +
          '<button type="button" class="btn-secondary" data-action="reopen">Reopen closed roads</button>'
        : "";
      var callHelp = res.emergency
        ? "<p><strong>Call 108 for an ambulance or 112 for any emergency.</strong></p>"
        : "";
      body.innerHTML = stale +
        '<div class="error-state" role="alert"><p class="state-title">No route found</p><p>' + esc(res.message) + "</p>" +
        callHelp + closed + "</div>";
      els.calc.hidden = true;
      return;
    }

    var best = res.recommended;
    var next = res.routes[1];
    var headline;
    if (res.priority === "safest") {
      headline = ", Route 1 " + esc(best.name) + " is safest with a risk score of <strong>" + fR(best.riskUnits) +
        "</strong> (" + esc(best.safety.label.toLowerCase()) + "), taking " + fT(best.timeUnits) + " min for " +
        fD(best.distanceUnits) + " km.";
    } else {
      var tail = "";
      if (next) {
        tail = next.extraTimeUnits === 0
          ? ", the same time as Route 2 " + esc(next.name) + " but shorter"
          : ", " + fT(next.extraTimeUnits) + " min quicker than Route 2 " + esc(next.name);
      }
      headline = ", Route 1 " + esc(best.name) + " is fastest at <strong>" + fT(best.timeUnits) + " min</strong> for " +
        fD(best.distanceUnits) + " km" + tail + ".";
    }
    var summary =
      '<p class="results-summary">From <strong>' + esc(res.origin.name) + "</strong> to <strong>" + esc(res.destination.name) +
      "</strong> under " + esc(conditionsPhrase()) + headline +
      (res.routes.length > 1 ? " " + esc(tradeoffText(res)) : "") + "</p>";
    var emergency = res.emergency ? emergencyHtml(res, best) : "";
    var single = res.routes.length === 1
      ? '<p class="note">Only one route connects these places in this network, so there is nothing to compare it with.</p>'
      : "";

    body.innerHTML = stale + emergency + summary + single +
      '<div class="route-list' + (state.stale ? " is-stale" : "") + '">' +
      res.routes.map(function (r) { return routeCard(r, res); }).join("") + "</div>" +
      '<p class="assumption">Each road\'s estimated time is its free-flow time multiplied by its ' +
      (isReal() ? "estimated" : "simulated") + " traffic factor. " +
      "Each road's risk score is its length times its risk points per km (1, plus extra for each hazard). " +
      "Route totals add those up, and every comparison above is the difference between the figures shown. Open “How this was calculated” for the road-by-road figures.</p>";
    renderCalc();
  }

  /** Joins consecutive segments that share keyFn's value, summing their units. */
  function groupSegments(segments, keyFn) {
    var out = [];
    segments.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && last.key === keyFn(s)) {
        last.toName = s.toName;
        last.distanceUnits += s.distanceUnits;
        last.freeFlowUnits += s.freeFlowUnits;
        last.timeUnits += s.timeUnits;
        last.riskUnits += s.riskUnits;
        last.count++;
        return;
      }
      out.push(Object.assign({}, s, { key: keyFn(s), count: 1 }));
    });
    return out;
  }

  function renderCalc() {
    var res = state.result;
    if (!res || !res.ok) {
      els.calc.hidden = true;
      return;
    }
    var real = isReal();
    var r = res.routes.filter(function (x) { return x.signature === state.focusedSig; })[0] || res.recommended;
    var timeRows = groupSegments(r.segments, function (s) { return s.roadName + "|" + s.level + "|" + s.freeFlowKmh; });
    var riskRows = groupSegments(r.segments, function (s) {
      return s.roadName + "|" + s.riskWeight + "|" + s.hazards.map(function (h) { return h.id; }).join();
    });
    var fromTo = function (s) {
      return real ? "" : "<td>" + esc(s.fromName) + "</td><td>" + esc(s.toName) + "</td>";
    };
    var rows = timeRows.map(function (s) {
      return "<tr><th scope=\"row\">" + esc(s.roadName) + (s.count > 1 ? ' <span class="muted">(' + s.count + " sections)</span>" : "") +
        "</th>" + fromTo(s) +
        '<td class="num">' + fD(s.distanceUnits) + '</td><td class="num">' + s.freeFlowKmh +
        '</td><td class="num">' + fT(s.freeFlowUnits) + '</td><td><span class="chip ' + s.level + '">' + esc(s.levelLabel) +
        '</span></td><td class="num">×' + s.factor.toFixed(1) + '</td><td class="num">' + fT(s.timeUnits) + "</td></tr>";
    }).join("");
    var riskBody = riskRows.map(function (s) {
      var hz = s.hazards.length
        ? s.hazards.map(function (h) { return esc(h.label) + " +" + h.weight; }).join("<br>")
        : '<span class="muted">None</span>';
      return "<tr><th scope=\"row\">" + esc(s.roadName) + '</th><td class="num">' + fD(s.distanceUnits) +
        "</td><td>" + hz + '</td><td class="num">' + s.riskWeight + '</td><td class="num">' + fR(s.riskUnits) + "</td></tr>";
    }).join("");
    var hazardWeights = D.HAZARD_ORDER.map(function (k) {
      return D.HAZARDS[k].label + " +" + D.HAZARDS[k].weight;
    }).join("; ");
    var lv = D.CONGESTION_LEVELS;
    var factors = D.CONGESTION_ORDER.map(function (k) {
      return lv[k].factor === null ? lv[k].label + ": road removed from the graph" : lv[k].label + " ×" + lv[k].factor.toFixed(1);
    }).join("; ");
    var speeds = Object.keys(D.ROAD_TYPES).map(function (k) {
      return D.ROAD_TYPES[k].label + " " + D.ROAD_TYPES[k].freeFlowKmh + " km/h";
    }).join("; ");
    var S = E.SETTINGS;
    var usesPenalty = D.NODES.length > S.yenMaxNodes;
    var head = real ? "" : '<th scope="col">From</th><th scope="col">To</th>';
    var footSpan = real ? 1 : 3;

    els.calcBody.innerHTML =
      "<p>Breakdown for <strong>" + esc(routeLabel(r)) + "</strong>. Choose “Show on map” on another route to see its figures." +
      (real ? " Rows join consecutive sections of the same road. Each row is rounded on its own; the totals use the exact values." : "") + "</p>" +
      '<div class="table-scroll"><table class="calc-table' + (real ? " is-real" : "") + '">' +
        '<caption class="visually-hidden">Road-by-road calculation for ' + esc(routeLabel(r)) + "</caption>" +
        '<thead><tr><th scope="col">Road</th>' + head +
        '<th scope="col" class="num">Distance (km)</th><th scope="col" class="num">Free-flow speed (km/h)</th>' +
        '<th scope="col" class="num">Free-flow time (min)</th><th scope="col">Traffic</th>' +
        '<th scope="col" class="num">Factor</th><th scope="col" class="num">Estimated time (min)</th></tr></thead>' +
        "<tbody>" + rows + "</tbody>" +
        '<tfoot><tr><th scope="row" colspan="' + footSpan + '">Route total</th><td class="num">' + fD(r.distanceUnits) +
        '</td><td></td><td class="num">' + fT(r.freeFlowUnits) + '</td><td colspan="2">Delay +' + fT(r.delayUnits) +
        ' min</td><td class="num">' + fT(r.timeUnits) + "</td></tr></tfoot>" +
      "</table></div>" +
      "<h3 class=\"calc-sub\">Safety</h3>" +
      '<div class="table-scroll"><table class="calc-table calc-table-risk">' +
        '<caption class="visually-hidden">Road-by-road safety risk for ' + esc(routeLabel(r)) + "</caption>" +
        '<thead><tr><th scope="col">Road</th><th scope="col" class="num">Distance (km)</th><th scope="col">Hazards (extra risk points per km)</th>' +
        '<th scope="col" class="num">Risk points per km</th><th scope="col" class="num">Risk score</th></tr></thead>' +
        "<tbody>" + riskBody + "</tbody>" +
        '<tfoot><tr><th scope="row">Route total</th><td class="num">' + fD(r.distanceUnits) + '</td><td colspan="2">' +
        esc(r.safety.label) + '</td><td class="num">' + fR(r.riskUnits) + "</td></tr></tfoot>" +
      "</table></div>" +
      '<div class="calc-notes">' +
        "<h3>Formula</h3>" +
        "<p>Free-flow time = distance ÷ free-flow speed × 60, rounded to " + (real ? "the nearest second" : "0.1 min") +
        ". Estimated time = free-flow time × traffic factor, rounded the same way. A route's time is the sum of its roads; delay = estimated time − free-flow time.</p>" +
        "<p>Risk score of a road = distance × risk points per km. Every km counts " + D.BASE_RISK +
        " point, and each hazard on the road adds its weight. A route's risk score is the sum of its roads. Average risk points per km up to " +
        S.saferMaxRisk.toFixed(1) + " is a safer route, up to " + S.cautionMaxRisk.toFixed(1) + " has some hazards, and above that is higher risk.</p>" +
        "<h3>" + (real ? "Estimated" : "Simulated") + " traffic factors</h3><p>" + esc(factors) + ".</p>" +
        "<h3>Assumed free-flow speeds</h3><p>" + esc(speeds) + "." +
        (real ? " Where a road has a lower posted speed limit in OpenStreetMap, that is used instead." : "") +
        " These are planning assumptions, not speed limits.</p>" +
        "<h3>" + (real ? "Hazard weights" : "Simulated hazard weights") + "</h3><p>" + esc(hazardWeights) + "." +
        (real
          ? " School/college zones and market areas are roads within 150 m of one on the map; busy junctions are where two named main roads meet or there are traffic signals. Black spots come from js/blackspots.js (" +
            BLACKSPOTS.length + " listed)."
          : " These are sample values for the demo, not accident statistics.") + "</p>" +
        "<h3>How routes are chosen</h3>" +
        "<p>The " + (real ? "road network" : "town") + " is a weighted graph: " + D.NODES.length + " locations and junctions (nodes) joined by " +
        D.EDGES.length + " road sections (edges)" + (real ? ", with one-way streets respected" : "") +
        ". For the fastest route each road is weighted by its estimated time; for the safest route, by its risk score. " +
        "Dijkstra's algorithm (with a priority queue) finds the best route for that weight. " +
        (usesPenalty
          ? "For alternatives, the penalty method makes the roads of each route found " + S.penaltyFactor +
            " times more expensive and searches again, up to " + S.penaltyRounds + " times, which pushes the search onto genuinely different roads. "
          : "Yen's k-shortest-paths algorithm, which re-runs Dijkstra with parts of earlier routes blocked, then lists up to " +
            S.candidatePool + " loop-free routes in order. ") +
        "An alternative is shown only if at most " +
        Math.round(S.maxSharedLength * 100) + "% of its length is shared with a route already shown, so the options are genuinely different; " +
        "if that leaves just one route, the next-best is added anyway. The fastest and the safest route are always both shown. " +
        "Ties on time go to the shorter route; ties on risk go to the quicker route.</p>" +
        "<p>Emergency mode searches once from the Start to every hospital" + (real ? " (except eye and dental hospitals)" : "") +
        " and picks the one with the shortest journey time.</p>" +
        "<p>Traffic label: light if a route takes at most " + Math.round((S.lightMaxRatio - 1) * 100) +
        "% longer than at free-flow, moderate up to " + Math.round((S.moderateMaxRatio - 1) * 100) + "%, heavy above that.</p>" +
      "</div>";
    els.calc.hidden = false;
  }

  function renderAll() {
    syncControls();
    renderMap();
    renderSummary();
    renderNotice();
    renderResults();
  }

  // ---------- events ----------

  els.modeOptions.addEventListener("change", function (ev) {
    if (ev.target.value !== mode) setMode(ev.target.value);
  });

  els.form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    runSearch();
  });

  function onSelectionChange() {
    clearFormError();
    state.stale = !!state.query &&
      (els.origin.value !== state.query.origin || els.destination.value !== state.query.destination);
    renderAll();
  }
  els.origin.addEventListener("change", onSelectionChange);
  els.destination.addEventListener("change", onSelectionChange);

  els.swap.addEventListener("click", function () {
    var o = els.origin.value;
    els.origin.value = els.destination.value;
    els.destination.value = o;
    onSelectionChange();
  });

  els.locate.addEventListener("click", locateMe);

  els.priorityOptions.addEventListener("change", function (ev) {
    setPriority(ev.target.value);
  });

  els.emergency.addEventListener("click", runEmergency);

  els.hour.addEventListener("input", function () {
    var hour = Number(els.hour.value);
    if (!isReal()) {
      setHour(hour);
      return;
    }
    // The real network is large: update the label at once, recalculate when
    // the slider settles.
    var band = E.bandForHour(D, hour);
    if (band) els.hourLabel.textContent = hourText(hour) + " · " + band.name;
    clearTimeout(hourTimer);
    hourTimer = setTimeout(function () { setHour(hour); }, 180);
  });

  els.now.addEventListener("click", function () {
    setHour(currentHour());
  });

  els.scenarioOptions.addEventListener("change", function (ev) {
    var sc = scenarioById(ev.target.value);
    if (!sc) return;
    applyTraffic(E.levelsForScenario(D, sc.id), null, sc.name + " traffic applied.");
  });

  els.roadSelect.addEventListener("change", function () {
    if (!edgeById[els.roadSelect.value]) return;
    state.selectedEdgeId = els.roadSelect.value;
    syncControls();
    renderMap();
  });

  els.levelOptions.addEventListener("change", function (ev) {
    if (!D.CONGESTION_LEVELS[ev.target.value] || !state.selectedEdgeId) return;
    setRoadLevel(state.selectedEdgeId, ev.target.value);
  });

  els.map.addEventListener("click", function (ev) {
    var g = ev.target.closest ? ev.target.closest("[data-edge]") : null;
    if (!g) return;
    state.selectedEdgeId = g.getAttribute("data-edge");
    syncControls();
    renderMap();
  });

  els.resultsBody.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    if (action === "sample") {
      els.origin.value = D.DEFAULTS.origin;
      els.destination.value = D.DEFAULTS.destination;
      runSearch();
    } else if (action === "reopen") {
      reopenClosedRoads();
    } else if (action === "hospital") {
      els.destination.value = btn.getAttribute("data-id");
      state.priority = "fastest";
      runSearch();
    } else if (action === "focus") {
      state.focusedSig = btn.getAttribute("data-sig");
      renderMap();
      renderResults();
      var again = els.resultsBody.querySelector('[data-sig="' + state.focusedSig + '"]');
      if (again) again.focus();
    }
  });

  els.reset.addEventListener("click", resetDemo);

  if (VIEWS.real) VIEWS.real.onAction = onMapAction;

  // ---------- start ----------
  var saved = null;
  try { saved = window.localStorage.getItem("route-mode"); } catch (err) { /* ignore */ }
  var hashMode = /mode=(real|demo)/.exec(window.location.hash);
  setMode(hashMode ? hashMode[1] : saved || (realAvailable ? "real" : "demo"));
})();
