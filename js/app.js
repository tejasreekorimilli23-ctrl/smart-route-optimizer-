/*
 * UI controller. Reads user input, asks RouteEngine for results, and renders
 * the planner, map, comparison cards and calculation breakdown.
 * All route numbers shown on the page come straight from RouteEngine output.
 *
 * Two modes share everything except the data and the map drawing:
 *  - "real": the real road network of the area (js/real-network-data.js,
 *    from OpenStreetMap) on a Leaflet map, with search, GPS, map clicks and
 *    optional live traffic from TomTom;
 *  - "demo": the small offline sample town on a schematic SVG map.
 * All text goes through t() (js/i18n.js): English or Telugu.
 */
(function () {
  "use strict";

  var E = window.RouteEngine;
  var G = window.GeoTools;
  var LT = window.LiveTraffic;
  var PS = window.PlaceSearch;
  var DIR = window.Directions;
  var TL = window.Translit;
  var I18N = window.I18N;
  var DATASETS = { demo: window.TrafficData, real: window.RealTrafficData };
  var VIEWS = { demo: window.MapView, real: window.RealMapView };

  function $(id) {
    return document.getElementById(id);
  }

  if (!E || !I18N || !DATASETS.demo || !VIEWS.demo) {
    var fatal = $("app-error");
    if (fatal) {
      fatal.textContent = "The route planner could not load its scripts. Keep the js folder next to index.html, then reload the page.";
      fatal.hidden = false;
    }
    return;
  }

  var realAvailable = !!(DATASETS.real && G && PS && VIEWS.real && VIEWS.real.available());
  var BLACKSPOTS = (Array.isArray(window.BLACKSPOTS) ? window.BLACKSPOTS : []).filter(function (b) {
    return b && typeof b.lat === "number" && typeof b.lon === "number" && b.name;
  });
  if (realAvailable) G.applyBlackspots(DATASETS.real, BLACKSPOTS);

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var PIN_IDS = { start: "u-start", destination: "u-dest" };
  var KEY_STORE = "tomtom-key";

  // Per-mode data, set by setMode().
  var lang = "en";
  var mode;
  var D;
  var M;
  var nodeById;
  var edgeById;
  var NODES_SORTED;
  var EDGES_SORTED;
  var DEFAULT_ROAD;
  var pins = {}; // role -> { node, edges } for GPS / map-click locations (real mode)
  var routing = null; // cached data including pins
  var state;
  var fitCounter = 0;
  var hourTimer = null;
  // TomTom live data (real mode): speeds on main roads and incidents.
  var live = { on: false, busy: false, flow: null, incidents: null, error: null, warn: false };
  var searches = {};

  var els = {
    langOptions: $("lang-options"),
    modeOptions: $("mode-options"),
    modeBadgeText: $("mode-badge-text"),
    form: $("route-form"),
    origin: $("origin"),
    destination: $("destination"),
    originSearch: $("origin-search"),
    destinationSearch: $("destination-search"),
    originList: $("origin-list"),
    destinationList: $("destination-list"),
    swap: $("swap"),
    locate: $("locate"),
    areaName: $("area-name"),
    areaChange: $("area-change"),
    areaBox: $("area-box"),
    areaQuery: $("area-query"),
    areaSearch: $("area-search"),
    areaStatus: $("area-status"),
    areaResults: $("area-results"),
    areaSaved: $("area-saved"),
    areaClose: $("area-close"),
    locateStatus: $("locate-status"),
    vehicleOptions: $("vehicle-options"),
    priorityOptions: $("priority-options"),
    emergency: $("emergency"),
    formError: $("form-error"),
    plannerNote: $("planner-note"),
    simTag: $("sim-tag"),
    liveToggle: $("live-toggle"),
    liveRefresh: $("live-refresh"),
    liveStatus: $("live-status"),
    liveIncidents: $("live-incidents"),
    communityPanel: $("community-panel"),
    communityStatus: $("community-status"),
    communityList: $("community-list"),
    reportHere: $("report-here"),
    reportTypes: $("report-types"),
    alertsBanner: $("alerts-banner"),
    tripPanel: $("trip-panel"),
    tripNext: $("trip-next"),
    tripLeft: $("trip-left"),
    tripNote: $("trip-note"),
    tripVoice: $("trip-voice"),
    tripShare: $("trip-share"),
    tripStop: $("trip-stop"),
    tripReports: $("trip-reports"),
    liveKeyBox: $("live-key-box"),
    liveKey: $("live-key"),
    liveKeySave: $("live-key-save"),
    liveKeyClear: $("live-key-clear"),
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

  // ---------- language ----------

  /** Translated text for key, with {name} placeholders filled from params. */
  function t(key, params) {
    var dict = I18N[lang] || I18N.en;
    var s = dict[key];
    if (s === undefined) s = I18N.en[key];
    if (s === undefined) return key;
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) {
        return params[k] !== undefined ? params[k] : m;
      });
    }
    return s;
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  /** Text from the data (labels written in English) with a translation if there is one. */
  function tData(key, english) {
    var dict = I18N[lang] || I18N.en;
    return dict[key] !== undefined ? dict[key] : english;
  }

  function applyStaticText() {
    document.documentElement.lang = lang;
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (el) {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-html]"), function (el) {
      el.innerHTML = t(el.getAttribute("data-i18n-html")); // trusted text from js/i18n.js
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-attr]"), function (el) {
      el.getAttribute("data-i18n-attr").split(";").forEach(function (pair) {
        var p = pair.split(":");
        el.setAttribute(p[0], t(p[1]));
      });
    });
    document.title = t("docTitle");
  }

  function setLang(next) {
    lang = I18N[next] ? next : "en";
    try { window.localStorage.setItem("route-lang", lang); } catch (err) { /* ignore */ }
    applyStaticText();
    if (D) {
      buildControls(true);
      renderAll();
      updateLiveStatus();
    }
  }

  // ---------- units and formatting ----------

  function fT(units) { return E.formatTime(D, units); }
  function fD(units) { return E.formatDistance(D, units); }
  function fR(units) { return E.formatRisk(D, units); }

  function isReal() {
    return mode === "real";
  }

  function levelLabel(k) { return t("level." + k); }
  function hazardLabel(id) { return tData("hazard." + id, D.HAZARDS[id] ? D.HAZARDS[id].label : id); }
  function roadTypeLabel(type) { return tData("roadType." + type, D.ROAD_TYPES[type] ? D.ROAD_TYPES[type].label : type); }
  function categoryLabel(cat) { return tData("cat." + slug(cat), cat); }
  function bandName(band) { return tData("band." + slug(band.name), band.name); }
  function bandDescription(band) {
    return tData("bandDesc." + mode + "." + slug(band.name), band.description);
  }
  function scenarioName(sc) { return tData("scenario." + sc.id, sc.name); }
  function scenarioDescription(sc) { return tData("scenarioDesc." + sc.id, sc.description); }
  function vehicleLabel(v) { return t("vehicle." + v); }

  // ---------- names in the page language ----------

  var teCache = {};

  /** A name from the map data in the page language (Telugu by transliteration). */
  function local(name) {
    if (lang !== "te" || !TL || !name) return name;
    if (!(name in teCache)) teCache[name] = TL.toTelugu(name);
    return teCache[name];
  }

  /** A place's name: its OpenStreetMap Telugu name if it has one, else transliterated. */
  function placeName(n) {
    if (!n) return "";
    return lang === "te" && n.nameTe ? n.nameTe : local(n.name);
  }

  function placeNameById(id) {
    return placeName(nodeById[id]);
  }

  /** Display name of a road (unnamed roads and access paths get a generic name). */
  function roadName(edge) {
    if (!edge) return "";
    if (edge.type === "access") return t("road.access");
    if (isReal() && !edge.corridor) return t("road.unnamed", { type: roadTypeLabel(edge.type).toLowerCase() });
    return local(edge.name);
  }

  function segRoadName(s) {
    return roadName(edgeById[s.edgeId] || { name: s.roadName, corridor: s.corridor, type: "" });
  }

  function routeName(r) {
    if (lang === "en") return r.name;
    var via = r.via ? local(r.via) : t("route.localStreets");
    return t("route.via", { road: via }) + (r.viaNumber > 1 ? " (" + r.viaNumber + ")" : "");
  }

  function routeLabel(r) {
    return t("route.label", { n: r.rank, name: routeName(r) });
  }

  /** 8 -> "8:00 AM" (English) or "ఉదయం 8:00" (Telugu). */
  function hourText(hour) {
    var h12 = hour % 12 === 0 ? 12 : hour % 12;
    if (lang === "te") {
      var part = hour < 12 ? "te.morning" : hour < 16 ? "te.afternoon" : hour < 19 ? "te.evening" : "te.night";
      return t(part) + " " + h12 + ":00";
    }
    return h12 + ":00 " + (hour < 12 ? "AM" : "PM");
  }

  function clockText(date) {
    var h = date.getHours();
    var m = String(date.getMinutes()).padStart(2, "0");
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return lang === "te" ? h12 + ":" + m : h12 + ":" + m + " " + (h < 12 ? "AM" : "PM");
  }

  // ---------- data including pinned points ----------

  function pinList() {
    return Object.keys(pins).map(function (k) { return pins[k]; });
  }

  /**
   * The current data plus any GPS / map-click locations, with the temporary
   * "incident" hazard on roads that have a live accident, closure or works.
   */
  function routeData() {
    var list = pinList();
    var unsafe = liveActive() && live.incidents && D.HAZARDS.incident ? live.incidents.unsafe.slice() : [];
    if (isReal() && D.HAZARDS.incident && typeof community !== "undefined") {
      community.fx.unsafe.forEach(function (id) { if (unsafe.indexOf(id) < 0) unsafe.push(id); });
    }
    if (!list.length && !unsafe.length) return D;
    if (!routing) {
      var marked = {};
      unsafe.forEach(function (id) { marked[id] = true; });
      var edges = unsafe.length
        ? D.EDGES.map(function (e) {
            return marked[e.id] ? Object.assign({}, e, { hazards: ["incident"].concat(e.hazards || []) }) : e;
          })
        : D.EDGES;
      routing = Object.assign({}, D, {
        NODES: D.NODES.concat(list.map(function (p) { return p.node; })),
        EDGES: edges.concat([].concat.apply([], list.map(function (p) { return p.edges; })))
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

  function engineOptions() {
    return { priority: state.priority, vehicle: state.vehicle };
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

  /**
   * Traffic for an hour: the time-of-day estimate, then live TomTom speeds,
   * then live incidents (the worse level wins), then the user's own edits.
   */
  function baseLevels(hour, withoutManual) {
    var levels = E.levelsForHour(D, hour) || E.levelsForScenario(D, D.DEFAULTS.scenarioId);
    if (liveActive()) {
      levels = Object.assign({}, levels);
      if (live.flow) Object.assign(levels, live.flow.levels);
      if (live.incidents) mergeWorse(levels, live.incidents.levels);
    }
    // What people and officials report applies whenever the real map is shown.
    if (isReal() && typeof community !== "undefined") {
      levels = Object.assign({}, levels, community.speedFx.levels);
      mergeWorse(levels, community.fx.levels);
    }
    if (!withoutManual && state && state.manual) levels = Object.assign({}, levels, state.manual);
    return levels;
  }

  function initialState(keep) {
    var hour = isReal() ? currentHour() : D.DEFAULTS.hour;
    var levels = baseLevels(hour, true); // a fresh start: no hand edits
    return {
      scenarioId: matchScenario(levels),
      hour: E.levelsForHour(D, hour) ? hour : null, // null when traffic is not set by the time slider
      levels: levels,
      priority: D.DEFAULTS.priority, // "fastest" or "safest"
      vehicle: keep && keep.vehicle ? keep.vehicle : "car",
      query: null, // { origin, destination, emergency } of the last successful search
      result: null, // RouteEngine output for that query
      focusedSig: null, // route shown in detail on the map and in the breakdown
      stale: false, // selection changed since the last search
      selectedEdgeId: DEFAULT_ROAD,
      notice: null,
      fitKey: null,
      manual: {} // roads the user set by hand: { edgeId: level }; kept on top of live updates
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

  function conditionsPhrase() {
    if (liveActive() && state.hour !== null) return t("cond.live");
    if (state.hour !== null) {
      return t(isReal() ? "cond.hourEstimated" : "cond.hour", { time: hourText(state.hour), band: bandName(E.bandForHour(D, state.hour)) });
    }
    var sc = scenarioById(state.scenarioId);
    return sc ? t("cond.scenario", { name: scenarioName(sc) }) : t("cond.custom");
  }

  function priorityWord() {
    return t(state.priority === "safest" ? "word.safest" : "word.fastest");
  }

  /** The headline figure for a route under the current priority. */
  function keyFigure(r) {
    return state.priority === "safest"
      ? t("fig.riskTime", { risk: fR(r.riskUnits), min: fT(r.timeUnits) })
      : t("fig.min", { min: fT(r.timeUnits) });
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
      return t(state.priority === "safest" ? "trade.alsoFastest" : "trade.alsoSafest");
    }
    var params = { route: routeLabel(other), other: fR(other.riskUnits), rec: fR(rec.riskUnits) };
    if (state.priority === "safest") {
      var saves = -other.extraTimeUnits;
      params.min = fT(saves);
      return t(saves > 0 ? "trade.fastestSaves" : "trade.fastestSame", params);
    }
    params.min = fT(other.extraTimeUnits);
    return t(other.extraTimeUnits > 0 ? "trade.safestLonger" : "trade.safestSame", params);
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

  /** Engine failure codes, in the page language. */
  function failureText(res, emergency) {
    var o = nodeById[(state.query && state.query.origin) || els.origin.value];
    var d = nodeById[(state.query && state.query.destination) || els.destination.value];
    switch (res.code) {
      case "MISSING_ORIGIN": return t(emergency ? "err.emergencyOrigin" : "err.missingOrigin");
      case "MISSING_DESTINATION": return t("err.missingDestination");
      case "INVALID_LOCATION": return t("err.invalidLocation");
      case "SAME_LOCATION": return t("err.same");
      case "AT_HOSPITAL": return t("err.atHospital", { name: placeName(o) });
      case "NO_HOSPITAL": return t("err.noHospital");
      case "UNREACHABLE":
        return emergency
          ? t("err.noHospitalRoute", { from: placeName(o) })
          : t("err.unreachable", { from: placeName(o), to: placeName(d) });
      default: return res.message;
    }
  }

  // ---------- build controls ----------

  function fillLocationSelect(sel, placeholder) {
    var keep = sel.value;
    sel.innerHTML = "";
    sel.add(new Option(placeholder, ""));
    if (!isReal()) {
      NODES_SORTED.forEach(function (n) { sel.add(new Option(placeName(n), n.id)); });
    } else {
      var list = pinList();
      if (list.length) {
        var g0 = document.createElement("optgroup");
        g0.label = t("cat.yourPoints");
        list.forEach(function (p) { g0.appendChild(new Option(p.node.name, p.node.id)); });
        sel.appendChild(g0);
      }
      D.PLACE_CATEGORIES.forEach(function (cat) {
        var items = NODES_SORTED.filter(function (n) { return n.category === cat; });
        if (!items.length) return;
        var g = document.createElement("optgroup");
        g.label = categoryLabel(cat);
        items.forEach(function (n) { g.appendChild(new Option(placeName(n), n.id)); });
        sel.appendChild(g);
      });
    }
    if (keep && nodeById[keep]) sel.value = keep;
  }

  function fillLocationSelects() {
    fillLocationSelect(els.origin, t(isReal() ? "plan.originPlaceholderReal" : "plan.originPlaceholder"));
    fillLocationSelect(els.destination, t("plan.destinationPlaceholder"));
  }

  // Words people type when looking for a kind of place, in both languages.
  var CATEGORY_WORDS = {
    "Hospitals": "hospital hospitals ఆసుపత్రి ఆస్పత్రి దవాఖానా హాస్పిటల్ వైద్యశాల",
    "Clinics": "clinic doctor క్లినిక్ దవాఖానా డాక్టర్ వైద్యుడు",
    "Schools and colleges": "school college university పాఠశాల బడి స్కూల్ కళాశాల కాలేజీ విశ్వవిద్యాలయం",
    "Transport": "railway station train bus stand stop రైల్వే స్టేషన్ రైలు బస్ బస్టాండ్ బస్సు స్టాప్",
    "Markets and shopping": "market shop shopping mall bazaar మార్కెట్ సంత బజార్ షాపింగ్ మాల్ దుకాణం",
    "Temples, mosques and churches": "temple mosque church గుడి ఆలయం దేవాలయం మందిరం మసీదు చర్చి",
    "Areas and junctions": "area colony nagar junction ప్రాంతం కాలనీ నగర్ జంక్షన్ కూడలి",
    "Other landmarks": "bank police post office petrol fuel cinema బ్యాంక్ పోలీస్ స్టేషన్ పోస్ట్ ఆఫీస్ పెట్రోల్ బంక్ సినిమా థియేటర్"
  };
  var NAME_WORDS = {
    temple: "గుడి దేవాలయం మందిరం", mandir: "గుడి ఆలయం", mandiram: "గుడి ఆలయం", masjid: "మసీదు", church: "చర్చి",
    hospital: "దవాఖానా ఆస్పత్రి", school: "బడి", college: "కాలేజీ", junction: "కూడలి", market: "సంత",
    bus: "బస్సు బస్టాండ్", station: "స్టేషన్", police: "ఠాణా పోలీస్ స్టేషన్", bank: "బ్యాంకు"
  };

  /** Extra words a place can be found by (kind of place, everyday Telugu words). */
  function searchWords(n) {
    var extra = [CATEGORY_WORDS[n.category] || ""];
    String(n.name).toLowerCase().split(/[^a-z]+/).forEach(function (w) {
      if (NAME_WORDS[w]) extra.push(NAME_WORDS[w]);
    });
    return extra.join(" ");
  }

  /** Search items for the place boxes (real mode). */
  function searchItems() {
    var pinsAsItems = pinList().map(function (p) {
      return { id: p.node.id, label: p.node.name, sub: t("cat.yourPoints") };
    });
    return pinsAsItems.concat(NODES_SORTED.map(function (n) {
      // Shown in the page language; found by English, Telugu or transliterated name.
      var shown = placeName(n);
      var other = shown === n.name ? "" : n.name;
      return {
        id: n.id, label: shown,
        sub: (other ? other + " · " : "") + categoryLabel(n.category),
        keywords: [n.name, n.nameTe || "", TL ? TL.toTelugu(n.name) : "", n.category, searchWords(n)].join(" ")
      };
    }));
  }

  function setupSearch(role) {
    var input = role === "start" ? els.originSearch : els.destinationSearch;
    var list = role === "start" ? els.originList : els.destinationList;
    var select = role === "start" ? els.origin : els.destination;
    searches[role] = PS.attach({
      input: input,
      list: list,
      items: searchItems,
      extras: function (q) {
        q = q.trim();
        if (!q) return role === "start" ? [{ id: "__locate", label: t("plan.locate"), special: true }] : [];
        if (q.length < 3 || !AL) return [];
        return [{ id: "__outside", label: t("search.outside", { q: q }), special: true, last: true }];
      },
      emptyText: function () { return t("search.none"); },
      onPick: function (item) {
        if (item.id === "__locate") {
          locateMe();
          return;
        }
        if (item.id === "__outside") {
          area.pending = { role: role };
          openAreaBox(input.value.trim());
          return;
        }
        select.value = item.id;
        input.value = item.label;
        onSelectionChange();
      },
      onBlur: syncSearchInputs
    });
  }

  /** Shows the chosen place in each search box (unless the user is typing in it). */
  function syncSearchInputs() {
    [[els.originSearch, els.origin], [els.destinationSearch, els.destination]].forEach(function (pair) {
      if (document.activeElement === pair[0]) return;
      var n = nodeById[pair[1].value];
      pair[0].value = n ? placeName(n) : "";
    });
    els.originSearch.placeholder = t("search.originPlaceholder");
    els.destinationSearch.placeholder = t("search.destinationPlaceholder");
  }

  function buildControls(keepValues) {
    var o = els.origin.value;
    var d = els.destination.value;
    els.origin.value = "";
    els.destination.value = "";
    fillLocationSelects();
    els.origin.value = keepValues ? o : D.DEFAULTS.origin || "";
    els.destination.value = keepValues ? d : D.DEFAULTS.destination || "";

    els.scenarioOptions.innerHTML = D.SCENARIOS.map(function (s) {
      return '<label class="tile"><input type="radio" name="scenario" value="' + esc(s.id) + '">' +
        '<span class="tile-body">' + esc(scenarioName(s)) + "</span></label>";
    }).join("");
    els.scenarioSet.hidden = !D.SCENARIOS.length;

    var road = els.roadSelect.value;
    els.roadSelect.innerHTML = "";
    if (!isReal()) EDGES_SORTED.forEach(function (e) { els.roadSelect.add(new Option(e.name, e.id)); });
    if (road) els.roadSelect.value = road;

    els.levelOptions.innerHTML = D.CONGESTION_ORDER.map(function (id) {
      return '<label class="seg"><input type="radio" name="road-level" value="' + esc(id) + '">' +
        '<span class="seg-body"><span class="seg-dot ' + esc(id) + '" aria-hidden="true"></span>' +
        esc(levelLabel(id)) + "</span></label>";
    }).join("");

    els.hour.min = D.DAY_START_HOUR;
    els.hour.max = D.DAY_END_HOUR;

    var mt = isReal() ? "real" : "demo";
    els.modeBadgeText.textContent = isReal() ? t("badge.real", { area: local(D.AREA.name) }) : t("badge.demo");
    renderAreaName();
    els.plannerNote.textContent = t("note.planner." + mt);
    els.trafficNote.textContent = t("note.traffic." + mt);
    els.mapNote.textContent = t("note.map." + mt);
    els.simTag.textContent = t(isReal() ? (liveActive() ? "tag.live" : "tag.estimated") : "tag.simulated");
  }

  function syncControls() {
    [["lang", lang], ["mode", mode], ["vehicle", state.vehicle], ["priority", state.priority], ["scenario", state.scenarioId]].forEach(function (pair) {
      Array.prototype.forEach.call(document.querySelectorAll('input[name="' + pair[0] + '"]'), function (input) {
        input.checked = input.value === pair[1];
      });
    });
    var liveNow = liveActive();
    var band = state.hour !== null ? E.bandForHour(D, state.hour) : null;
    if (band) {
      els.hour.value = state.hour;
      els.hourLabel.textContent = liveNow ? t("time.liveLabel") : hourText(state.hour) + " · " + bandName(band);
      els.hour.setAttribute("aria-valuetext", hourText(state.hour) + ", " + bandName(band));
    } else {
      els.hourLabel.textContent = t("time.notInUse");
      els.hour.setAttribute("aria-valuetext", t("time.notInUseLong"));
    }
    els.hour.disabled = !!liveNow;
    els.now.disabled = !!liveNow;
    els.hour.classList.toggle("is-inactive", !band || !!liveNow);
    var sc = scenarioById(state.scenarioId);
    els.scenarioDesc.textContent = liveNow && band
      ? t("time.liveDesc")
      : band
        ? bandDescription(band)
        : sc
          ? scenarioDescription(sc)
          : t(D.SCENARIOS.length ? "time.customDescScenario" : "time.customDesc");
    if (isReal()) {
      var e = edgeById[state.selectedEdgeId];
      els.roadPicked.textContent = e
        ? t("editor.picked", { road: roadName(e), level: levelLabel(state.levels[e.id] || "light") })
        : t("editor.pickHint");
      syncSearchInputs();
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

  function setMode(next) {
    if (next === "real" && !realAvailable) next = "demo";
    var keep = state;
    mode = next;
    try { window.localStorage.setItem("route-mode", mode); } catch (err) { /* private mode: ignore */ }
    D = DATASETS[mode];
    M = VIEWS[mode];
    if (typeof trip !== "undefined" && trip.on) stopTrip();
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
    $("origin-label").htmlFor = isReal() ? "origin-search" : "origin";
    $("destination-label").htmlFor = isReal() ? "destination-search" : "destination";
    els.locateStatus.textContent = "";

    state = initialState(keep);
    buildControls(false);
    clearFormError();
    if (els.calc) els.calc.open = false;
    renderAll();
    updateLiveStatus();
    if (isReal()) setTimeout(function () { VIEWS.real.invalidate(); }, 0);
    if (typeof community !== "undefined") {
      community.reports = [];
      community.alerts = [];
      community.fx = { levels: {}, unsafe: [], byEdge: {} };
      community.speedFx = { levels: {}, roads: 0 };
      community.signature = "";
      renderCommunity();
      if (isReal()) refreshCommunity(true);
    }
  }

  // ---------- form validation ----------

  function fieldFor(select) {
    if (!isReal()) return select;
    return select === els.origin ? els.originSearch : els.destinationSearch;
  }

  function showFormError(message, select) {
    els.formError.textContent = message;
    els.formError.hidden = false;
    [els.origin, els.destination, els.originSearch, els.destinationSearch].forEach(function (s) { s.removeAttribute("aria-invalid"); });
    if (select) {
      var field = fieldFor(select);
      field.setAttribute("aria-invalid", "true");
      field.focus();
    }
  }

  function clearFormError() {
    els.formError.hidden = true;
    els.formError.textContent = "";
    [els.origin, els.destination, els.originSearch, els.destinationSearch].forEach(function (s) { s.removeAttribute("aria-invalid"); });
  }

  // ---------- actions ----------

  function compute(query) {
    return query.emergency
      ? E.findEmergencyRoute(routeData(), routeLevels(), query.origin, { vehicle: state.vehicle })
      : E.findRoutes(routeData(), routeLevels(), query.origin, query.destination, engineOptions());
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
      showFormError(failureText(res, false), res.code === "MISSING_ORIGIN" ? els.origin : els.destination);
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
      showFormError(failureText(res, true), els.origin);
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
      return { kind: "warn", text: cause + " " + failureText(res, res.emergency) };
    }
    var rec = res.recommended;
    if (!prev || !prev.ok) {
      return { kind: "changed", text: cause + " " + t("notice.available", { route: routeName(rec), min: fT(rec.timeUnits) }) };
    }
    var old = prev.recommended;
    if (old.signature === rec.signature) {
      var was = old.timeUnits !== rec.timeUnits ? " " + t("notice.was", { min: fT(old.timeUnits) }) : "";
      return {
        kind: "same",
        text: cause + " " + t("notice.unchanged", { route: routeName(rec), word: priorityWord(), fig: keyFigure(rec) }) + was + "."
      };
    }
    var oldNow = E.evaluatePath(routeData(), routeLevels(), old.edges, { vehicle: state.vehicle });
    var oldPart = oldNow.closed
      ? t("notice.oldClosed", { route: routeName(old) })
      : t("notice.oldNow", { route: routeName(old), min: fT(oldNow.timeUnits) });
    return {
      kind: "changed",
      text: cause + " " + t("notice.changed", { route: routeName(rec), word: priorityWord(), fig: keyFigure(rec) }) + " " + oldPart
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
    if (!E.levelsForHour(D, hour)) return;
    state.manual = {};
    applyTraffic(baseLevels(hour), hour, t("cause.hour", { time: hourText(hour), band: bandName(E.bandForHour(D, hour)) }));
  }

  /** Explains the trade-off after a choice that did not change the traffic. */
  function choiceNotice(prev, res, cause) {
    if (!res.ok) return buildNotice(prev, res, cause);
    var rec = res.recommended;
    var kind = prev && prev.ok && prev.recommended.signature === rec.signature ? "same" : "changed";
    var text = cause + " " + routeLabel(rec) + ": " + keyFigure(rec) + ".";
    if (res.routes.length > 1) text += " " + tradeoffText(res);
    return { kind: kind, text: text };
  }

  function setPriority(priority) {
    if (!E.PRIORITIES[priority] || priority === state.priority) return;
    state.priority = priority;
    // An emergency is always the fastest route; choosing "safest" turns it
    // into an ordinary search to the same hospital.
    if (state.query && state.query.emergency && priority === "safest") state.query.emergency = false;
    recalc(t("cause.priority." + priority), choiceNotice);
  }

  function setVehicle(vehicle) {
    if (!E.VEHICLES[vehicle] || vehicle === state.vehicle) return;
    state.vehicle = vehicle;
    recalc(t("cause.vehicle", { vehicle: vehicleLabel(vehicle) }), choiceNotice);
  }

  function setRoadLevel(edgeId, level) {
    if (!D.CONGESTION_LEVELS[level] || state.levels[edgeId] === undefined) return;
    state.selectedEdgeId = edgeId;
    var levels = Object.assign({}, state.levels);
    var before = levels[edgeId];
    levels[edgeId] = level;
    state.manual[edgeId] = level;
    var name = roadName(edgeById[edgeId]);
    var cause;
    if (level === "closed") cause = t("cause.closed", { road: name });
    else if (before === "closed") cause = t("cause.reopened", { road: name, level: levelLabel(level) });
    else cause = t("cause.set", { road: name, level: levelLabel(level) });
    applyTraffic(levels, null, cause);
  }

  function reopenClosedRoads() {
    var levels = {};
    var count = 0;
    Object.keys(state.levels).forEach(function (k) {
      if (state.levels[k] === "closed") {
        count++;
        state.manual[k] = "light";
      }
      levels[k] = state.levels[k] === "closed" ? "light" : state.levels[k];
    });
    applyTraffic(levels, null, t(count === 1 ? "cause.reopenedOne" : "cause.reopenedMany"));
  }

  function resetDemo() {
    pins = {};
    routing = null;
    indexData();
    state = initialState(state);
    buildControls(false);
    clearFormError();
    els.locateStatus.textContent = "";
    if (els.calc) els.calc.open = false;
    renderAll();
  }

  /**
   * Pins a GPS position or map click as the start or destination.
   * Returns false (and explains why) if it is too far from any road.
   */
  function setPin(role, lat, lon, kind, label) {
    var id = PIN_IDS[role];
    var pinned = G.pinToRoad(D, id, "", lat, lon);
    var select = role === "start" ? els.origin : els.destination;
    if (!pinned) {
      showFormError(t("err.outside", { metres: G.MAX_PIN_METRES, area: local(D.AREA.name) }), select);
      return false;
    }
    pinned.node.name = kind === "gps" ? t("pin.myLocation") : kind === "place" && label ? label : t("pin.pointOn", { road: roadName(pinned.road) });
    pins[role] = pinned;
    routing = null;
    indexData();
    fillLocationSelects();
    select.value = id;
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
      els.locateStatus.textContent = t("gps.unsupported");
      return;
    }
    els.locateStatus.textContent = t("gps.finding");
    navigator.geolocation.getCurrentPosition(function (pos) {
      var c = pos.coords;
      if (setPin("start", c.latitude, c.longitude, "gps")) {
        els.locateStatus.textContent = t("gps.done", { metres: Math.round(c.accuracy) });
        searchIfReady();
      } else {
        els.locateStatus.textContent = "";
      }
    }, function (err) {
      els.locateStatus.textContent = t(err.code === 1 ? "gps.denied" : "gps.failed");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function onMapAction(action, payload) {
    if (!isReal()) return;
    if (action === "set-start" || action === "set-destination") {
      var role = action === "set-start" ? "start" : "destination";
      if (setPin(role, payload.lat, payload.lng, "map")) searchIfReady();
    } else if (action === "choose-start" || action === "choose-destination") {
      (action === "choose-start" ? els.origin : els.destination).value = payload;
      searchIfReady();
    } else if (action === "select-road") {
      state.selectedEdgeId = payload;
      syncControls();
      renderMap();
    } else if (action === "set-level") {
      setRoadLevel(payload.edgeId, payload.level);
    } else if (action === "report") {
      sendReport(payload.lat, payload.lng, payload.type, payload.edgeId);
    } else if (action === "vote") {
      vote(payload.id, payload.kind);
    }
  }

  // ---------- live traffic and incidents (TomTom, real mode) ----------

  var SEVERITY = { light: 0, moderate: 1, heavy: 2, closed: 3 };

  function savedKey() {
    try { return window.localStorage.getItem(KEY_STORE) || ""; } catch (err) { return ""; }
  }

  /** True when live TomTom data is switched on and has arrived. */
  function liveActive() {
    return isReal() && live.on && !!(live.flow || live.incidents);
  }

  /** Copies b's levels into a, keeping the more congested level for each road. */
  function mergeWorse(a, b) {
    Object.keys(b).forEach(function (id) {
      if (!a[id] || SEVERITY[b[id]] > SEVERITY[a[id]]) a[id] = b[id];
    });
    return a;
  }

  function incidentLabel(inc) {
    return t("incident." + inc.category);
  }

  /** The road an incident is on: its longest named section, else its longest one. */
  function incidentRoad(inc) {
    var edges = inc.edges.map(function (id) { return edgeById[id]; }).filter(Boolean);
    edges.sort(function (a, b) { return (b.corridor ? 1 : 0) - (a.corridor ? 1 : 0) || b.distanceKm - a.distanceKm; });
    return edges[0];
  }

  /** "1 incident in the area, 246 road sections with live speeds" */
  function liveSummary() {
    var parts = [];
    if (live.incidents) {
      var n = live.incidents.incidents.filter(function (i) { return i.edges.length; }).length;
      parts.push(n === 0 ? t("live.noIncident") : n === 1 ? t("live.oneIncident") : t("live.nIncidents", { n: n }));
    }
    if (live.flow) parts.push(t("live.nRoads", { n: live.flow.roads }));
    return parts.join(", ");
  }

  /** Short line describing an incident: "Accident · RTC Complex Road · +5 min · since 1:05 PM". */
  function incidentText(inc) {
    var e = incidentRoad(inc);
    var parts = [incidentLabel(inc)];
    var where = e ? roadName(e) : inc.from;
    if (where) parts.push(where);
    if (inc.delaySeconds >= 60) parts.push(t("incident.delay", { min: Math.round(inc.delaySeconds / 60) }));
    if (inc.level === "closed") parts.push(t("incident.closedRoad"));
    if (inc.startTime && !isNaN(inc.startTime)) parts.push(t("incident.since", { time: clockText(inc.startTime) }));
    return parts.join(" · ");
  }

  function incidentTip(inc) {
    return incidentText(inc) + (inc.description ? " — " + inc.description : "") +
      (inc.from && inc.to ? " (" + inc.from + " → " + inc.to + ")" : "");
  }

  function renderIncidentList() {
    var list = els.liveIncidents;
    var incs = liveActive() && live.incidents ? live.incidents.incidents.filter(function (i) { return i.edges.length; }) : [];
    list.hidden = !(liveActive() && live.incidents);
    if (list.hidden) {
      list.innerHTML = "";
      return;
    }
    if (!incs.length) {
      list.innerHTML = '<li class="inc-none">' + esc(t("live.noIncidents")) + "</li>";
      return;
    }
    var shown = incs.slice().sort(function (a, b) {
      return SEVERITY[b.level || "light"] - SEVERITY[a.level || "light"] || b.delaySeconds - a.delaySeconds;
    }).slice(0, 6);
    list.innerHTML = shown.map(function (inc) {
      var i = live.incidents.incidents.indexOf(inc);
      return '<li><button type="button" class="inc-item inc-' + esc(inc.category) + (inc.level === "closed" ? " is-closed" : "") +
        '" data-incident="' + i + '">' + esc(incidentText(inc)) + "</button></li>";
    }).join("") + (incs.length > shown.length ? '<li class="inc-none">' + esc(t("card.more", { n: incs.length - shown.length })) + "</li>" : "");
  }

  function updateLiveStatus() {
    if (!LT) return;
    var key = savedKey();
    els.liveToggle.checked = live.on;
    els.liveToggle.disabled = !key || live.busy;
    els.liveRefresh.hidden = !live.on || live.busy;
    els.liveKeyClear.hidden = !key;
    var text;
    if (!key) text = t("live.needKey");
    else if (live.busy && !liveActive()) text = t("live.loading");
    else if (live.error) text = t("live.err." + (live.error.code || "noanswer"));
    else if (liveActive()) {
      var latest = [live.flow && live.flow.fetchedAt, live.incidents && live.incidents.fetchedAt].filter(Boolean)
        .sort(function (a, b) { return b - a; })[0];
      text = t("live.updated", { time: clockText(latest), summary: liveSummary() });
      if (live.warn) text += " " + t("live.partial");
    } else text = t("live.off");
    els.liveStatus.textContent = text;
    els.liveStatus.classList.toggle("is-error", !!live.error);
    els.simTag.textContent = t(isReal() ? (liveActive() ? "tag.live" : "tag.estimated") : "tag.simulated");
    if (VIEWS.real && VIEWS.real.setLiveOverlay) VIEWS.real.setLiveOverlay(liveActive() && live.flow ? LT.overlayUrl(key) : null);
    renderIncidentList();
  }

  function safely(make) {
    try {
      return make();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** One-line summary of what live data changed, for the notice above the map. */
  function liveCause(first) {
    return t(first ? "cause.live" : "cause.liveUpdate", { summary: liveSummary() });
  }

  /**
   * Fetches live data: speeds and/or incidents. The first time (when live is
   * switched on) both are needed; a refused key or the daily limit switch
   * live off again. Later automatic updates keep the last good data if one
   * part fails.
   */
  function refreshLive(want) {
    if (live.busy) return;
    want = want || { speeds: true, incidents: true };
    var key = savedKey();
    var first = !liveActive();
    live.busy = true;
    live.error = null;
    updateLiveStatus();
    var jobs = [
      want.speeds ? safely(function () { return LT.fetchLive(D, key); }).then(ok, bad) : Promise.resolve(null),
      want.incidents ? safely(function () { return LT.fetchIncidents(D, key); }).then(ok, bad) : Promise.resolve(null)
    ];
    function ok(v) { return { ok: v }; }
    function bad(e) { return { err: e }; }
    Promise.all(jobs).then(function (out) {
      live.busy = false;
      var speeds = out[0];
      var incidents = out[1];
      var errors = [speeds, incidents].filter(function (r) { return r && r.err; }).map(function (r) { return r.err; });
      var fatal = errors.filter(function (e) { return e.code === "denied" || e.code === "limit" || e.code === "nokey"; })[0];
      var gotSomething = (speeds && speeds.ok) || (incidents && incidents.ok);
      if (fatal || (first && !gotSomething)) {
        live.error = fatal || errors[0];
        live.on = false;
        live.flow = null;
        live.incidents = null;
        routing = null;
        indexData();
        updateLiveStatus();
        if (!first) applyTraffic(baseLevels(state.hour !== null ? state.hour : currentHour()), state.hour, t("cause.liveOff"));
        else syncControls();
        return;
      }
      var before = JSON.stringify([live.flow && live.flow.levels, live.incidents && live.incidents.levels, live.incidents && live.incidents.unsafe]);
      if (speeds && speeds.ok) live.flow = speeds.ok;
      if (incidents && incidents.ok) live.incidents = incidents.ok;
      live.warn = errors.length > 0;
      live.on = true;
      var after = JSON.stringify([live.flow && live.flow.levels, live.incidents && live.incidents.levels, live.incidents && live.incidents.unsafe]);
      routing = null;
      indexData();
      updateLiveStatus();
      // Live data describes now: use the current hour for the estimate under it.
      var hour = currentHour();
      if (first || before !== after || state.hour !== hour) {
        applyTraffic(baseLevels(hour), hour, liveCause(first));
      }
    });
  }

  function setLive(on) {
    if (!isReal()) return;
    if (on) {
      refreshLive();
    } else {
      live.on = false;
      live.flow = null;
      live.incidents = null;
      live.error = null;
      live.warn = false;
      routing = null;
      indexData();
      updateLiveStatus();
      var hour = state.hour !== null ? state.hour : currentHour();
      applyTraffic(baseLevels(hour), hour, t("cause.liveOff"));
    }
  }

  /**
   * Automatic updates while live is on and the page is visible: incidents
   * every 2 minutes (1 request), speeds every 15 minutes (up to 80 requests).
   */
  function autoTick() {
    if (!liveActive() || live.busy || document.hidden) return;
    var now = Date.now();
    var S = LT.SETTINGS;
    var want = {
      incidents: !live.incidents || now - live.incidents.fetchedAt >= S.incidentsEveryMs,
      speeds: !live.flow || now - live.flow.fetchedAt >= S.speedsEveryMs
    };
    if (want.incidents || want.speeds) refreshLive(want);
  }



  // ---------- community: reports from people, official alerts, shared speeds ----------

  var CM = window.Community;
  var store = CM ? CM.connect(window.FIREBASE_CONFIG, window.localStorage) : null;
  var community = {
    reports: [], // active reports in the current area
    alerts: [], // active official alerts
    speeds: [],
    fx: { levels: {}, unsafe: [], byEdge: {} },
    speedFx: { levels: {}, roads: 0 },
    busy: false,
    error: null,
    signature: ""
  };
  var COMMUNITY_EVERY_MS = 60 * 1000;
  var lastCommunityAt = 0;

  function readVotes() {
    try { return JSON.parse(window.localStorage.getItem("community-votes") || "{}"); } catch (err) { return {}; }
  }

  function saveVote(id, kind) {
    var v = readVotes();
    v[id] = kind;
    try { window.localStorage.setItem("community-votes", JSON.stringify(v)); } catch (err) { /* ignore */ }
  }

  function inArea(p) {
    var b = D && D.AREA ? D.AREA.bbox : null;
    return !b || (p.lat >= b[0] && p.lat <= b[2] && p.lon >= b[1] && p.lon <= b[3]);
  }

  function minutesAgo(date) {
    var m = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    return m < 1 ? t("time.justNow") : m < 60 ? t("time.minAgo", { n: m }) : t("time.hoursAgo", { n: Math.floor(m / 60) });
  }

  /** Words for a report: used on the map, in the list and on route cards. */
  function reportInfo(r) {
    var votes = readVotes();
    var edge = edgeById[r.edgeId];
    var parts = [];
    if (edge) parts.push(roadName(edge));
    if (r.createdAt) parts.push(t("report.reported", { ago: minutesAgo(r.createdAt) }));
    if (r.confirms) parts.push(t("report.confirms", { n: r.confirms }));
    if (r.clears) parts.push(t("report.clears", { n: r.clears }));
    if (r.note) parts.push("“" + r.note + "”");
    return {
      title: t("report.type." + r.type),
      detail: parts.join(" · "),
      canVote: !votes[r.id] && store,
      votedText: votes[r.id] ? t(votes[r.id] === "mine" ? "report.yours" : "report.thanks") : ""
    };
  }

  function communitySummary() {
    var n = community.reports.length;
    var parts = [n === 0 ? t("community.noReports") : n === 1 ? t("community.oneReport") : t("community.nReports", { n: n })];
    if (community.alerts.length) parts.push(t("community.nAlerts", { n: community.alerts.length }));
    if (community.speedFx.roads) parts.push(t("community.nSpeeds", { n: community.speedFx.roads }));
    return parts.join(", ");
  }

  function renderCommunity() {
    if (!els.communityStatus) return;
    var connected = store && store.mode === "firebase";
    els.communityStatus.textContent = community.error
      ? t("community.err." + (community.error.code || "failed"))
      : t(connected ? "community.connected" : "community.local") + " " + communitySummary() + ".";
    els.communityStatus.classList.toggle("is-error", !!community.error);
    var list = community.reports.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 6);
    els.communityList.innerHTML = list.map(function (r, i) {
      var info = reportInfo(r);
      return '<li><button type="button" class="inc-item rp-' + esc(r.type) + '" data-report="' + i + '">' +
        esc(info.title + " · " + info.detail) + "</button></li>";
    }).join("");
    els.communityList.hidden = !list.length;
    community.listed = list;
    // Official alerts: a banner everyone sees.
    els.alertsBanner.hidden = !community.alerts.length;
    els.alertsBanner.innerHTML = community.alerts.map(function (a) {
      var until = a.endsAt ? " " + t("alert.until", { time: clockText(a.endsAt) }) : "";
      return '<div class="alert-item"><p class="alert-title"><span class="alert-kind">' + esc(t("alert.kind." + (a.kind || "other"))) + "</span> " +
        esc(a.title || "") + "</p>" + (a.message ? "<p>" + esc(a.message) + "</p>" : "") +
        '<p class="alert-meta">' + esc(t("alert.official") + until) + "</p></div>";
    }).join("");
  }

  /**
   * Loads reports, alerts and shared speeds. When they change what is on
   * the roads, the routes are recalculated with a notice saying why.
   */
  function refreshCommunity(force) {
    if (!store || !isReal() || community.busy) return;
    if (!force && (document.hidden || Date.now() - lastCommunityAt < COMMUNITY_EVERY_MS)) return;
    community.busy = true;
    lastCommunityAt = Date.now();
    var now = new Date();
    Promise.all([store.listReports(now), store.listAlerts(now), store.listSpeeds(now)]).then(function (out) {
      community.busy = false;
      community.error = null;
      var areaNow = D;
      community.reports = out[0].filter(function (r) { return CM.isActive(r, now) && inArea(r); });
      community.alerts = out[1].filter(function (a) { return CM.isAlertActive(a, now); });
      community.speeds = out[2];
      var graph = E.buildGraph(areaNow, null, "fastest", "car");
      community.fx = CM.effects(community.reports, community.alerts, now);
      community.speedFx = CM.speedLevels(areaNow, community.speeds, now, function (e) {
        return graph.edgeInfo[e.id] ? graph.edgeInfo[e.id].freeFlowKmh : 0;
      });
      var sig = JSON.stringify([community.fx.levels, community.fx.unsafe, community.speedFx.levels]);
      var changed = sig !== community.signature;
      community.signature = sig;
      renderCommunity();
      if (changed) {
        routing = null;
        indexData();
        var hour = state.hour !== null ? state.hour : currentHour();
        applyTraffic(baseLevels(hour), state.hour, t("cause.community", { summary: communitySummary() }));
      } else {
        renderMap();
      }
    }, function (err) {
      community.busy = false;
      community.error = err;
      renderCommunity();
    });
  }

  /** Sends a report for a point (map tap or GPS). */
  function sendReport(lat, lon, type, edgeId) {
    if (!store) return;
    var e = edgeId ? edgeById[edgeId] : null;
    if (!e) {
      var hit = G.nearestRoad(D, lat, lon);
      if (!hit || hit.metres > 80) {
        flashCommunity(t("report.err.noroad"), true);
        return;
      }
      e = hit.edge;
    }
    var input = { type: type, lat: lat, lon: lon, edgeId: e.id, roadName: e.name, area: D.AREA.name };
    if (CM.validateReport(input)) {
      flashCommunity(t("report.err.invalid"), true);
      return;
    }
    store.addReport(CM.newReport(input, new Date())).then(function (saved) {
      if (saved && saved.id) saveVote(saved.id, "mine");
      flashCommunity(t(store.mode === "firebase" ? "report.sent" : "report.sentLocal"), false);
      refreshCommunity(true);
    }, function (err) {
      flashCommunity(t("community.err." + (err.code || "failed")), true);
    });
  }

  function vote(id, kind) {
    var r = community.reports.filter(function (x) { return x.id === id; })[0];
    if (!r || readVotes()[id]) return;
    saveVote(id, kind);
    store.vote(r, kind).then(function () { refreshCommunity(true); }, function (err) {
      flashCommunity(t("community.err." + (err.code || "failed")), true);
    });
  }

  function flashCommunity(text, isError) {
    els.communityStatus.textContent = text;
    els.communityStatus.classList.toggle("is-error", !!isError);
    els.communityPanel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }

  /** "Report at my location": GPS, then the chosen kind of problem. */
  function reportHere(type) {
    if (!navigator.geolocation) {
      flashCommunity(t("gps.unsupported"), true);
      return;
    }
    flashCommunity(t("gps.finding"), false);
    navigator.geolocation.getCurrentPosition(function (pos) {
      sendReport(pos.coords.latitude, pos.coords.longitude, type, null);
    }, function (err) {
      flashCommunity(t(err.code === 1 ? "gps.denied" : "report.err.gps"), true);
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }


  // ---------- trip mode: follow GPS, next turn, voice, re-routing ----------

  var TR = window.Trip;
  var trip = { on: false };

  function metresText(m) {
    if (m < 1000) return t("unit.metres", { m: Math.max(10, Math.round(m / 10) * 10) });
    return t("fig.km", { km: (m / 1000).toFixed(1) });
  }

  /** An instruction without its "for 300 m" part, for "In 200 m: …". */
  function stepShort(step, r) {
    if (step.kind === "arrive") return t("dir.arrive", { place: placeNameById(r.nodes[r.nodes.length - 1]) });
    var road = stepRoad(step);
    return step.kind === "depart"
      ? t("dir.depart", { dir: t("dir.compass." + step.compass), road: road })
      : t("dir.turn." + step.turn, { road: road });
  }

  function tripRoute() {
    var res = state.result;
    if (!res || !res.ok) return null;
    return res.routes.filter(function (r) { return r.signature === state.focusedSig; })[0] || res.recommended;
  }

  function prepareTrip(route) {
    trip.route = route;
    trip.sig = route.signature;
    trip.ln = TR.line(route, edgeById);
    trip.steps = routeSteps(route);
    trip.alongs = TR.stepAlongs(trip.ln, trip.steps);
    trip.offRoute = TR.offRouteCounter();
    trip.track = TR.speedTracker(trip.ln);
    trip.lastStep = -1;
    trip.said = [];
  }

  // ----- voice -----

  function voiceFor(langCode) {
    if (!window.speechSynthesis) return null;
    var want = langCode === "te" ? "te" : "en";
    var voices = window.speechSynthesis.getVoices() || [];
    return voices.filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf(want) === 0; })
      .sort(function (a, b) { return (b.lang === (want + "-IN")) - (a.lang === (want + "-IN")); })[0] || null;
  }

  function speak(text) {
    if (!trip.voice || !window.speechSynthesis || !text) return;
    var voice = voiceFor(lang);
    if (!voice) {
      els.tripNote.textContent = t(lang === "te" ? "trip.noTeluguVoice" : "trip.noVoice");
      return;
    }
    var u = new window.SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  // ----- following the GPS -----

  function onFix(pos) {
    if (!trip.on) return;
    var p = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
    VIEWS.real.setPosition(p, true);
    var route = tripRoute();
    if (!route) {
      els.tripNext.textContent = t("trip.noRoute");
      return;
    }
    if (route.signature !== trip.sig) prepareTrip(route); // a new route after a re-route or a live update
    var at = TR.locate(trip.ln, p);
    if (trip.offRoute(at)) {
      reroute(p);
      return;
    }
    // Shared speeds (only if the user agreed, and not on foot).
    var measured = trip.track(at, pos.timestamp || Date.now());
    if (measured && trip.share && store && state.vehicle !== "walk") {
      store.addSpeed({
        edgeId: measured.edgeId, kmh: measured.kmh, vehicle: state.vehicle,
        at: new Date(), expiresAt: new Date(Date.now() + CM.SETTINGS.speedMinutes * 60000)
      }).catch(function () { /* a lost reading does not matter */ });
    }
    var st = TR.status(trip.ln, trip.alongs, at);
    if (st.arrived) {
      els.tripNext.textContent = t("trip.arrived");
      els.tripLeft.textContent = "";
      speak(t("trip.arrived"));
      setTimeout(stopTrip, 4000);
      trip.on = false;
      return;
    }
    var step = trip.steps[st.nextIndex];
    var instr = stepShort(step, route);
    els.tripNext.textContent = st.toNextMetres > 40
      ? t("trip.in", { dist: metresText(st.toNextMetres), instr: instr })
      : t("trip.now", { instr: instr });
    var eta = new Date(Date.now() + (st.remainingUnits / E.unitsOf(D).perMin) * 60000);
    els.tripLeft.textContent = t("trip.left", { min: fT(st.remainingUnits), km: metresText(st.remainingMetres), eta: clockText(eta) });
    if (st.nextIndex !== trip.lastStep) {
      trip.lastStep = st.nextIndex;
      trip.said = [];
      speak(els.tripNext.textContent);
    } else {
      var due = TR.reminderDue(st.toNextMetres, trip.said);
      if (due) {
        trip.said.push(due);
        speak(t("trip.in", { dist: metresText(due), instr: instr }));
      }
    }
  }

  /** Off the route: plan again from where the traveller is now. */
  function reroute(p) {
    if (trip.rerouting) return;
    trip.rerouting = true;
    els.tripNext.textContent = t("trip.rerouting");
    speak(t("trip.rerouting"));
    if (setPin("start", p.lat, p.lon, "gps")) {
      runSearch();
      var route = tripRoute();
      if (route) prepareTrip(route);
    }
    trip.rerouting = false;
  }

  function onFixError(err) {
    els.tripNext.textContent = t(err.code === 1 ? "gps.denied" : "trip.gpsWait");
  }

  function startTrip() {
    var route = tripRoute();
    if (!TR || !route || !navigator.geolocation) {
      els.tripNote.textContent = t(navigator.geolocation ? "trip.noRoute" : "gps.unsupported");
      els.tripPanel.hidden = false;
      return;
    }
    prepareTrip(route);
    trip.on = true;
    els.tripPanel.hidden = false;
    els.tripNext.textContent = t("trip.waiting");
    els.tripLeft.textContent = "";
    els.tripNote.textContent = "";
    trip.voice = els.tripVoice.checked;
    trip.share = els.tripShare.checked;
    trip.watch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
    // Keep the screen on while travelling, where the browser allows it.
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request("screen").then(function (lock) { trip.lock = lock; }, function () { /* not allowed: fine */ });
    }
    els.mapPanel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    speak(t("trip.started"));
  }

  function stopTrip() {
    trip.on = false;
    if (trip.watch !== undefined && navigator.geolocation) navigator.geolocation.clearWatch(trip.watch);
    trip.watch = undefined;
    if (trip.lock) { trip.lock.release().catch(function () {}); trip.lock = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (VIEWS.real && VIEWS.real.setPosition) VIEWS.real.setPosition(null);
    els.tripPanel.hidden = true;
  }

  // ---------- areas: any town, not only the built-in one ----------

  var AL = window.AreaLoader;
  var BUILT_IN = DATASETS.real;
  var area = { busy: false, results: [], pending: null };

  function setAreaStatus(text, isError) {
    els.areaStatus.textContent = text || "";
    els.areaStatus.classList.toggle("is-error", !!isError);
  }

  function areaErrorText(err) {
    return t("area.err." + (err && err.code ? err.code : "download"));
  }

  /** Shows a different area's real road network. */
  function switchArea(data, keyForStorage) {
    G.applyBlackspots(data, BLACKSPOTS);
    DATASETS.real = data;
    try { window.localStorage.setItem("route-area", keyForStorage || "builtin"); } catch (err) { /* ignore */ }
    var wasLive = live.on;
    live.on = false;
    live.flow = null;
    live.incidents = null;
    live.error = null;
    setMode("real");
    els.areaBox.hidden = true;
    if (wasLive && savedKey()) refreshLive();
  }

  function renderAreaName() {
    if (!els.areaName) return;
    var d = DATASETS.real;
    els.areaName.textContent = d ? t("area.current", { name: local(d.AREA.name) }) : "";
  }

  /** Remembered areas and the built-in one, as buttons. */
  function renderSavedAreas() {
    var items = [{ key: "builtin", name: BUILT_IN.AREA.name, builtin: true }];
    (AL ? AL.list() : Promise.resolve([])).then(function (saved) {
      saved.forEach(function (a) { if (a.key !== BUILT_IN.AREA.key) items.push(a); });
      els.areaSaved.innerHTML = '<p class="area-sub">' + esc(t("area.saved")) + "</p>" + items.map(function (a) {
        var current = (DATASETS.real.AREA.key || "builtin") === a.key || (a.builtin && DATASETS.real === BUILT_IN);
        return '<button type="button" class="area-pick' + (current ? " is-current" : "") + '" data-area-key="' + esc(a.key) + '">' +
          esc(local(a.name)) + (a.builtin ? " · " + esc(t("area.builtin")) : "") + "</button>";
      }).join("");
    });
  }

  function openAreaBox(query) {
    els.areaBox.hidden = false;
    renderSavedAreas();
    if (query) {
      els.areaQuery.value = query;
      searchAreas();
    } else {
      els.areaQuery.focus();
    }
  }

  function searchAreas() {
    var q = els.areaQuery.value.trim();
    if (q.length < 2 || !AL) return;
    setAreaStatus(t("area.searching"));
    els.areaResults.innerHTML = "";
    // Prefer India; search everywhere if nothing is found there.
    AL.find(q, { countryCodes: "in", language: "en" }).then(function (rows) {
      return rows.length ? rows : AL.find(q, { language: "en" });
    }).then(function (rows) {
      area.results = rows;
      if (!rows.length) {
        setAreaStatus(t("area.none"), true);
        return;
      }
      setAreaStatus(t("area.pick"));
      els.areaResults.innerHTML = rows.map(function (r, i) {
        return '<li><button type="button" class="area-pick" data-area-result="' + i + '">' + esc(local(r.label)) + "</button></li>";
      }).join("");
    }, function (err) {
      setAreaStatus(areaErrorText(err), true);
    });
  }

  /**
   * Loads the area for a search result. If a place for the other end of the
   * trip is already chosen and close enough, the area covers both, and the
   * chosen result becomes the start or destination (area.pending).
   */
  function loadResult(r) {
    if (area.busy) return;
    var box = AL.boxForResult(r);
    var keep = null;
    if (area.pending) {
      var otherSelect = area.pending.role === "start" ? els.destination : els.origin;
      var other = nodeById[otherSelect.value];
      if (other && other.lat !== undefined) {
        var both = AL.boxAround({ lat: other.lat, lon: other.lon }, r);
        if (both) {
          box = both;
          keep = { role: area.pending.role === "start" ? "destination" : "start", lat: other.lat, lon: other.lon, name: placeName(other) };
        }
      }
    }
    area.busy = true;
    els.areaSearch.disabled = true;
    setAreaStatus(t("area.step.roads"));
    var pending = area.pending;
    AL.load(r.name, box, function (step, seconds) { setAreaStatus(t("area.step." + step, { s: seconds })); }).then(function (data) {
      area.busy = false;
      els.areaSearch.disabled = false;
      area.pending = null;
      AL.remember(data);
      switchArea(data, data.AREA.key);
      // Put the searched place (and the kept other end) on the new map.
      if (pending) {
        if (keep) setPin(keep.role, keep.lat, keep.lon, "place", keep.name);
        setPin(pending.role, r.lat, r.lon, "place", local(r.name));
        searchIfReady();
      }
      setAreaStatus("");
    }, function (err) {
      area.busy = false;
      els.areaSearch.disabled = false;
      setAreaStatus(areaErrorText(err), true);
    });
  }

  function pickSavedArea(key) {
    if (key === "builtin") {
      switchArea(BUILT_IN, "builtin");
      return;
    }
    setAreaStatus(t("area.opening"));
    AL.recall(key).then(function (data) {
      if (!data) {
        setAreaStatus(t("area.err.nostore"), true);
        return;
      }
      setAreaStatus("");
      switchArea(data, key);
    });
  }

  /** On start: reopen the area used last time, if it was not the built-in one. */
  function restoreArea() {
    var key = null;
    try { key = window.localStorage.getItem("route-area"); } catch (err) { /* ignore */ }
    if (!AL || !key || key === "builtin") return;
    AL.recall(key).then(function (data) {
      if (data && mode === "real") switchArea(data, key);
    });
  }


  // ---------- sharing a route as a link ----------

  /**
   * Link that opens the same route on any device. Places are shared by
   * position and name (not internal ids), so the link works even if the
   * other phone has a different copy of the map.
   */
  function shareLink() {
    var q = state.query;
    if (!q || !isReal()) return null;
    var a = nodeById[q.origin];
    var b = nodeById[q.destination];
    if (!a || !b || a.lat === undefined || b.lat === undefined) return null;
    var enc = function (n) {
      return n.lat.toFixed(5) + "," + n.lon.toFixed(5) + "," + encodeURIComponent(n.pinned ? "" : n.name);
    };
    return window.location.origin + window.location.pathname +
      "#mode=real&lang=" + lang + "&from=" + enc(a) + "&to=" + enc(b) + "&v=" + state.vehicle + "&p=" + state.priority;
  }

  function shareText(res) {
    var r = res.recommended;
    return t("share.text", {
      from: placeName(res.origin), to: placeName(res.destination),
      min: fT(r.timeUnits), km: fD(r.distanceUnits), by: t("by." + state.vehicle), word: priorityWord()
    });
  }

  function shareRow(res) {
    if (!isReal() || !shareLink()) return "";
    var url = shareLink();
    var wa = "https://wa.me/?text=" + encodeURIComponent(shareText(res) + " " + url);
    return '<div class="share-row">' +
      '<button type="button" class="btn-secondary" data-action="share">' + esc(t("share.button")) + "</button>" +
      '<a class="btn-secondary share-wa" href="' + esc(wa) + '" target="_blank" rel="noopener">' + esc(t("share.whatsapp")) + "</a>" +
      '<span class="share-status" role="status" aria-live="polite"></span></div>';
  }

  function doShare(btn) {
    var res = state.result;
    var url = shareLink();
    if (!res || !res.ok || !url) return;
    var status = btn.parentNode.querySelector(".share-status");
    var text = shareText(res);
    if (navigator.share) {
      navigator.share({ title: t("docTitle"), text: text, url: url }).catch(function () { /* cancelled */ });
      return;
    }
    var done = function () { status.textContent = t("share.copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text + " " + url).then(done, function () { status.textContent = url; });
    } else {
      status.textContent = url;
    }
  }

  /** Reads from=lat,lon,name and to=... from the page address. */
  function sharedTrip() {
    var h = window.location.hash;
    var get = function (k) {
      var m = new RegExp("[#&]" + k + "=([^&]*)").exec(h);
      return m ? m[1] : null;
    };
    var point = function (v) {
      if (!v) return null;
      var parts = v.split(",");
      var lat = Number(parts[0]);
      var lon = Number(parts[1]);
      if (!isFinite(lat) || !isFinite(lon)) return null;
      return { lat: lat, lon: lon, name: decodeURIComponent(parts.slice(2).join(",") || "") };
    };
    var a = point(get("from"));
    var b = point(get("to"));
    if (!a || !b) return null;
    return { a: a, b: b, vehicle: get("v"), priority: get("p") };
  }

  /** A place of the current map at (about) that point with that name, else a pin. */
  function placeAt(p, role) {
    var best = null;
    if (p.name) {
      D.NODES.forEach(function (n) {
        if (!n.category || n.name !== p.name) return;
        var d = G.haversine(n, p);
        if (d < 60 && (!best || d < best.d)) best = { id: n.id, d: d };
      });
    }
    if (best) return best.id;
    return setPin(role, p.lat, p.lon, "place", p.name ? local(p.name) : null) ? PIN_IDS[role] : null;
  }

  function showShared(s) {
    if (s.vehicle && E.VEHICLES[s.vehicle]) state.vehicle = s.vehicle;
    if (s.priority && E.PRIORITIES[s.priority]) state.priority = s.priority;
    var o = placeAt(s.a, "start");
    var d = placeAt(s.b, "destination");
    if (!o || !d) return;
    fillLocationSelects();
    els.origin.value = o;
    els.destination.value = d;
    runSearch();
  }

  /**
   * Opens a shared route: uses the map on this device if it covers both
   * ends, else downloads the area around them.
   */
  function openShared(s) {
    var covers = function (data) {
      return AL && AL.contains(data.AREA.bbox, s.a) && AL.contains(data.AREA.bbox, s.b);
    };
    if (covers(DATASETS.real)) {
      showShared(s);
      return;
    }
    if (covers(BUILT_IN)) {
      switchArea(BUILT_IN, "builtin");
      showShared(s);
      return;
    }
    if (!AL) return;
    AL.list().then(function (saved) {
      var hit = saved.filter(function (a) {
        var box = a.key.split(",").map(Number);
        return box.length === 4 && AL.contains(box, s.a) && AL.contains(box, s.b);
      })[0];
      if (hit) {
        return AL.recall(hit.key).then(function (data) {
          if (data) {
            switchArea(data, hit.key);
            showShared(s);
          }
        });
      }
      var box = AL.boxAround(s.a, s.b);
      if (!box) return;
      els.areaBox.hidden = false;
      setAreaStatus(t("share.loadingArea"));
      return AL.load(s.b.name || s.a.name || "Shared route", box, function (step, seconds) {
        setAreaStatus(t("area.step." + step, { s: seconds }));
      }).then(function (data) {
        AL.remember(data);
        switchArea(data, data.AREA.key);
        setAreaStatus("");
        showShared(s);
      }, function (err) {
        setAreaStatus(areaErrorText(err), true);
      });
    });
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
      fitKey: state.fitKey,
      placeName: placeName,
      t: t,
      hazardLabel: hazardLabel,
      incidents: liveActive() && live.incidents ? live.incidents.incidents : [],
      incidentTip: incidentTip,
      reports: isReal() ? community.reports : [],
      reportInfo: reportInfo
    });
  }

  function renderSummary() {
    var res = state.result;
    var html;
    if (!state.query || !res) {
      html = t("summary.empty");
    } else if (!res.ok) {
      html = esc(t("summary.none"));
    } else {
      var r = res.recommended;
      var p = { route: "<strong>" + esc(routeLabel(r)) + "</strong>", min: fT(r.timeUnits), km: fD(r.distanceUnits) };
      if (res.emergency) {
        p.hospital = esc(placeName(res.hospital));
        html = '<span class="emg-flag">' + esc(t("summary.emergencyFlag")) + "</span> " + t("summary.emergency", p);
      } else {
        p.word = esc(priorityWord());
        p.vehicle = esc(vehicleLabel(state.vehicle));
        html = t("summary.recommended", p);
      }
    }
    if (state.stale) html += ' <span class="stale-flag">' + esc(t("summary.stale")) + "</span>";
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
      if (!next) return t("cmp.only");
      if (safest) {
        if (next.extraRiskUnits === 0) return t("cmp.tieRisk");
        return t("cmp.safest", { risk: fR(next.extraRiskUnits) });
      }
      if (next.extraTimeUnits === 0) return t("cmp.tieTime");
      return t("cmp.fastest", { min: fT(next.extraTimeUnits) });
    }
    var tu = r.extraTimeUnits;
    var timePart = tu === 0 ? t("cmp.sameTime") : tu > 0 ? t("cmp.slower", { min: fT(tu) }) : t("cmp.faster", { min: fT(-tu) });
    var d = r.extraDistanceUnits;
    var distPart = d > 0 ? t("cmp.longer", { km: fD(d) }) : d < 0 ? t("cmp.shorter", { km: fD(-d) }) : t("cmp.sameDistance");
    if (safest) {
      var k = r.extraRiskUnits;
      var riskPart = k === 0 ? t("cmp.sameRisk") : t("cmp.riskHigher", { risk: fR(k) });
      return riskPart + ", " + timePart + ", " + distPart;
    }
    return timePart + ", " + distPart;
  }

  function hazardList(r) {
    if (!r.hazards.length) return '<p class="hazards none">' + esc(t("card.noHazards")) + "</p>";
    var seen = {};
    var items = [];
    r.segments.forEach(function (s) {
      s.hazards.forEach(function (h) {
        var road = segRoadName(s);
        var inc = h.id === "incident" && live.incidents ? live.incidents.byEdge[s.edgeId] : null;
        var rep = h.id === "incident" && !inc ? community.fx.byEdge[s.edgeId] : null;
        var label = inc ? t("incident.liveOn", { label: incidentLabel(inc) })
          : rep ? t(rep.alert ? "alert.on" : "report.on", { label: t(rep.alert ? "alert.kind." + (rep.alert.kind || "other") : "report.type." + rep.type) })
          : hazardLabel(h.id);
        var key = label + "|" + road;
        if (seen[key]) return;
        seen[key] = true;
        items.push({ id: h.id, road: road, label: label });
      });
    });
    return '<ul class="hazards" aria-label="' + esc(t("card.hazardsLabel", { route: routeLabel(r) })) + '">' +
      items.map(function (h) {
        return '<li class="hz-' + esc(h.id) + '">' + t("card.hazardOn", { hazard: "<strong>" + esc(h.label) + "</strong>", road: esc(h.road) }) + "</li>";
      }).join("") + "</ul>";
  }

  function trafficBar(r) {
    var total = r.distanceUnits;
    var parts = ["light", "moderate", "heavy"].filter(function (k) { return r.levelDistanceUnits[k] > 0; });
    var label = parts.map(function (k) {
      return t("card.barPart", { km: fD(r.levelDistanceUnits[k]), level: levelLabel(k) });
    }).join(", ");
    return '<div class="traffic-bar" role="img" aria-label="' + esc(t("card.barLabel", { parts: label })) + '">' +
      parts.map(function (k) {
        var pct = (r.levelDistanceUnits[k] / total) * 100;
        return '<span class="tb ' + k + '" style="width:' + pct.toFixed(2) + '%"></span>';
      }).join("") + "</div>";
  }

  /** Real mode: the roads a route follows, in order, each named once per stretch. */
  function roadSequence(r) {
    var out = [];
    r.segments.forEach(function (s) {
      var e = edgeById[s.edgeId];
      if (e && e.type === "access") return;
      var name = s.corridor ? local(s.roadName) : t("route.localLanes");
      if (out.length && out[out.length - 1] === name) return;
      out.push(name);
    });
    return out;
  }

  function stopsList(r) {
    var items;
    if (isReal()) {
      var roads = roadSequence(r);
      var shown = roads.length > 9 ? roads.slice(0, 8).concat([t("card.more", { n: roads.length - 8 })]) : roads;
      items = [placeNameById(r.nodes[0])].concat(shown, [placeNameById(r.nodes[r.nodes.length - 1])]);
      return '<ol class="stops is-roads" aria-label="' + esc(t("card.roadsLabel", { route: routeLabel(r) })) + '">' +
        items.map(function (name, i) {
          return "<li" + (i > 0 && i < items.length - 1 ? ' class="road"' : "") + ">" + esc(name) + "</li>";
        }).join("") + "</ol>";
    }
    items = r.nodes.map(placeNameById);
    return '<ol class="stops" aria-label="' + esc(t("card.stopsLabel", { route: routeLabel(r) })) + '">' +
      items.map(function (name) { return "<li>" + esc(name) + "</li>"; }).join("") + "</ol>";
  }

  /** "350 m" or "1.2 km" for a leg, from the route's distance units. */
  function legDistance(units) {
    var metres = (units / E.unitsOf(D).perKm) * 1000;
    if (metres < 1000) return t("unit.metres", { m: Math.max(10, Math.round(metres / 10) * 10) });
    return t("fig.km", { km: (metres / 1000).toFixed(1) });
  }

  /** Name of the road a step follows: the whole road's name, not one section's. */
  function stepRoad(step) {
    var e = edgeById[step.roadEdgeId];
    if (!e) return "";
    return e.corridor ? local(e.corridor) : roadName(e);
  }

  /** One instruction in the page language. */
  function stepText(step, r) {
    if (step.kind === "arrive") return t("dir.arrive", { place: placeNameById(r.nodes[r.nodes.length - 1]) });
    var road = stepRoad(step);
    var text = step.kind === "depart"
      ? t("dir.depart", { dir: t("dir.compass." + step.compass), road: road })
      : t("dir.turn." + step.turn, { road: road });
    return text + " " + t("dir.follow", { dist: legDistance(step.units) });
  }

  function routeSteps(r) {
    return DIR ? DIR.build(r, edgeById, nodeById) : [];
  }

  function directionsList(r) {
    var steps = routeSteps(r);
    if (!steps.length) return "";
    return '<details class="directions"><summary>' + esc(t("dir.title", { n: steps.length })) + "</summary><ol>" +
      steps.map(function (s, i) {
        return '<li class="dir-' + esc(s.kind === "turn" ? s.turn : s.kind) + '"><button type="button" class="dir-step" data-action="step" data-sig="' +
          esc(r.signature) + '" data-step="' + i + '">' + esc(stepText(s, r)) + "</button></li>";
      }).join("") + "</ol></details>";
  }

  function routeCard(r, res) {
    var focused = r.signature === state.focusedSig;
    var id = "route-title-" + r.rank;
    var badge = (r.isRecommended ? '<p class="rec-badge">' + esc(t("card.recommended")) + "</p>" : "") +
      (r.isFastest ? '<p class="tag-badge">' + esc(t("card.fastest")) + "</p>" : "") +
      (r.isSafest ? '<p class="tag-badge is-safe">' + esc(t("card.safest")) + "</p>" : "");
    var mapBtnLabel = t(focused ? "card.shown" : "card.show");
    return (
      '<article class="route-card' + (r.isRecommended ? " is-recommended" : "") + (focused ? " is-focused" : "") +
        '" aria-labelledby="' + id + '">' +
        '<div class="route-head">' +
          swatchSvg(r.rank) +
          '<h3 id="' + id + '"><span class="route-num">' + esc(t("route.num", { n: r.rank })) + '</span> <span class="route-name">' + esc(routeName(r)) + "</span></h3>" +
          badge +
        "</div>" +
        '<dl class="route-metrics">' +
          '<div class="metric metric-time"><dt>' + esc(t("card.time")) + '</dt><dd><span class="num">' + fT(r.timeUnits) + "</span> " + esc(t("unit.min")) + "</dd></div>" +
          '<div class="metric"><dt>' + esc(t("card.distance")) + '</dt><dd><span class="num">' + fD(r.distanceUnits) + "</span> " + esc(t("unit.km")) + "</dd></div>" +
          '<div class="metric"><dt>' + esc(t("card.traffic")) + '</dt><dd><span class="chip ' + r.congestion.key + '">' + esc(t("congestion." + r.congestion.key)) + "</span>" +
            '<span class="sub">' + esc(t("card.delay", { min: fT(r.delayUnits), pct: r.delayPercent })) + "</span></dd></div>" +
          '<div class="metric metric-safety"><dt>' + esc(t("card.safety")) + '</dt><dd><span class="chip ' + r.safety.tone + '">' + esc(t("rating." + r.safety.key)) + "</span>" +
            '<span class="sub">' + esc(t("card.risk", { risk: fR(r.riskUnits) })) + "</span></dd></div>" +
          '<div class="metric"><dt>' + esc(t("card.compared")) + '</dt><dd class="cmp">' + esc(comparisonText(r, res)) + "</dd></div>" +
        "</dl>" +
        trafficBar(r) +
        hazardList(r) +
        stopsList(r) +
        directionsList(r) +
        '<div class="card-actions">' +
        '<button type="button" class="map-toggle" data-action="focus" data-sig="' + esc(r.signature) + '" aria-pressed="' + focused + '">' + esc(mapBtnLabel) + "</button>" +
        (isReal() && focused ? '<button type="button" class="trip-start" data-action="trip">' + esc(t("trip.start")) + "</button>" : "") +
        "</div>" +
      "</article>"
    );
  }

  function emptyStateHtml() {
    var o = nodeById[D.DEFAULTS.origin];
    var d = nodeById[D.DEFAULTS.destination];
    var tip = isReal()
      ? o && d ? t("empty.real", { from: placeName(o), to: placeName(d) }) : t("empty.realArea")
      : t("empty.demo");
    return '<div class="empty-state">' +
        '<p class="state-title">' + esc(t("empty.title")) + "</p>" +
        "<p>" + esc(tip) + "</p>" +
        (o && d ? '<button type="button" class="btn-secondary" data-action="sample">' + esc(t("empty.sample")) + "</button>" : "") +
      "</div>";
  }

  function emergencyHtml(res, best) {
    var others = (res.nearestHospitals || []).slice(1);
    var list = others.length
      ? "<p>" + esc(t("emg.others")) + " " + others.map(function (h) {
          return '<button type="button" class="link-btn inline" data-action="hospital" data-id="' + esc(h.hospital.id) + '">' +
            esc(placeName(h.hospital)) + "</button> (" + esc(t("fig.min", { min: fT(h.timeUnits) })) + ")";
        }).join(", ") + ".</p>"
      : "";
    return '<div class="emergency-banner" role="alert">' +
        '<p class="state-title">' + esc(t("emg.title", { hospital: placeName(res.hospital) })) + "</p>" +
        "<p>" + t("emg.body", {
          from: esc(placeName(res.origin)), route: "<strong>" + esc(routeLabel(best)) + "</strong>", min: fT(best.timeUnits)
        }) + (isReal() ? " " + esc(t("emg.check")) : "") + "</p>" + list +
        "<p><strong>" + esc(t("emg.call")) + "</strong> " + esc(t("emg.drive")) + "</p>" +
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
      ? '<p class="stale-banner">' + esc(t("results.stale", {
          from: nodeById[q.origin] ? placeName(nodeById[q.origin]) : t("results.earlierStart"),
          to: q.destination && nodeById[q.destination] ? placeName(nodeById[q.destination]) : t("results.nearestHospital")
        })) + "</p>"
      : "";

    if (!res.ok) {
      var closed = res.closedRoads && res.closedRoads.length
        ? "<p>" + t("results.closedNow", { roads: "<strong>" + res.closedRoads.map(esc).join(", ") + "</strong>" }) + "</p>" +
          '<button type="button" class="btn-secondary" data-action="reopen">' + esc(t("results.reopen")) + "</button>"
        : "";
      var callHelp = res.emergency ? "<p><strong>" + esc(t("emg.call")) + "</strong></p>" : "";
      body.innerHTML = stale +
        '<div class="error-state" role="alert"><p class="state-title">' + esc(t("results.noRoute")) + "</p><p>" +
        esc(failureText(res, res.emergency)) + "</p>" + callHelp + closed + "</div>";
      els.calc.hidden = true;
      return;
    }

    var best = res.recommended;
    var next = res.routes[1];
    var p = {
      from: "<strong>" + esc(placeName(res.origin)) + "</strong>",
      to: "<strong>" + esc(placeName(res.destination)) + "</strong>",
      cond: esc(conditionsPhrase()),
      by: esc(t("by." + state.vehicle)),
      route: esc(routeLabel(best)),
      min: fT(best.timeUnits),
      km: fD(best.distanceUnits),
      risk: fR(best.riskUnits),
      rating: esc(t("rating." + best.safety.key))
    };
    var headline;
    if (res.priority === "safest") {
      headline = t("results.headSafest", p);
    } else {
      headline = t("results.headFastest", p);
      if (next) {
        headline += next.extraTimeUnits === 0
          ? " " + t("results.tailTie", { route: esc(routeLabel(next)) })
          : " " + t("results.tailQuicker", { min: fT(next.extraTimeUnits), route: esc(routeLabel(next)) });
      }
    }
    var summary = '<p class="results-summary">' + headline +
      (res.routes.length > 1 ? " " + esc(tradeoffText(res)) : "") + "</p>" + shareRow(res);
    var emergency = res.emergency ? emergencyHtml(res, best) : "";
    var single = res.routes.length === 1 ? '<p class="note">' + esc(t("results.single")) + "</p>" : "";

    body.innerHTML = stale + emergency + summary + single +
      '<div class="route-list' + (state.stale ? " is-stale" : "") + '">' +
      res.routes.map(function (r) { return routeCard(r, res); }).join("") + "</div>" +
      '<p class="assumption">' + esc(t(isReal() ? "results.assumptionReal" : "results.assumptionDemo")) + "</p>";
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
      out.push(Object.assign({}, s, { key: keyFn(s), name: segRoadName(s), count: 1 }));
    });
    return out;
  }

  function factorText(f) {
    return "×" + (Math.round(f * 10) === f * 10 ? f.toFixed(1) : f.toFixed(2));
  }

  function renderCalc() {
    var res = state.result;
    if (!res || !res.ok) {
      els.calc.hidden = true;
      return;
    }
    var real = isReal();
    var r = res.routes.filter(function (x) { return x.signature === state.focusedSig; })[0] || res.recommended;
    var timeRows = groupSegments(r.segments, function (s) { return segRoadName(s) + "|" + s.level + "|" + s.freeFlowKmh; });
    var riskRows = groupSegments(r.segments, function (s) {
      return segRoadName(s) + "|" + s.riskWeight + "|" + s.hazards.map(function (h) { return h.id; }).join();
    });
    var fromTo = function (s) {
      return real ? "" : "<td>" + esc(s.fromName) + "</td><td>" + esc(s.toName) + "</td>";
    };
    var rows = timeRows.map(function (s) {
      return "<tr><th scope=\"row\">" + esc(s.name) + (s.count > 1 ? ' <span class="muted">(' + esc(t("calc.sections", { n: s.count })) + ")</span>" : "") +
        "</th>" + fromTo(s) +
        '<td class="num">' + fD(s.distanceUnits) + '</td><td class="num">' + s.freeFlowKmh +
        '</td><td class="num">' + fT(s.freeFlowUnits) + '</td><td><span class="chip ' + s.level + '">' + esc(levelLabel(s.level)) +
        '</span></td><td class="num">' + factorText(s.factor) + '</td><td class="num">' + fT(s.timeUnits) + "</td></tr>";
    }).join("");
    var riskBody = riskRows.map(function (s) {
      var hz = s.hazards.length
        ? s.hazards.map(function (h) { return esc(hazardLabel(h.id)) + " +" + h.weight; }).join("<br>")
        : '<span class="muted">' + esc(t("calc.none")) + "</span>";
      return "<tr><th scope=\"row\">" + esc(s.name) + '</th><td class="num">' + fD(s.distanceUnits) +
        "</td><td>" + hz + '</td><td class="num">' + s.riskWeight + '</td><td class="num">' + fR(s.riskUnits) + "</td></tr>";
    }).join("");
    var hazardWeights = D.HAZARD_ORDER.map(function (k) {
      return hazardLabel(k) + " +" + D.HAZARDS[k].weight;
    }).join("; ");
    var lv = D.CONGESTION_LEVELS;
    var factors = D.CONGESTION_ORDER.map(function (k) {
      return lv[k].factor === null ? t("calc.closedFactor", { level: levelLabel(k) }) : levelLabel(k) + " ×" + lv[k].factor.toFixed(1);
    }).join("; ");
    var speeds = Object.keys(D.ROAD_TYPES).map(function (k) {
      return roadTypeLabel(k) + " " + D.ROAD_TYPES[k].freeFlowKmh + " " + t("unit.kmh");
    }).join("; ");
    var V = E.VEHICLES;
    var vehicles = Object.keys(V).map(function (k) {
      var v = V[k];
      var parts = [];
      if (v.fixedKmh) parts.push(t("calc.vFixed", { kmh: v.fixedKmh }));
      if (v.maxKmh) parts.push(t("calc.vMax", { kmh: v.maxKmh }));
      parts.push(t("calc.vJam", { pct: Math.round(v.congestionScale * 100) }));
      if (v.ignoresOneway) parts.push(t("calc.vOneway"));
      return vehicleLabel(k) + ": " + parts.join(", ");
    }).join("; ");
    var S = E.SETTINGS;
    var usesPenalty = D.NODES.length > S.yenMaxNodes;
    var head = real ? "" : '<th scope="col">' + esc(t("calc.from")) + '</th><th scope="col">' + esc(t("calc.to")) + "</th>";
    var footSpan = real ? 1 : 3;
    var tl = esc(routeLabel(r));

    els.calcBody.innerHTML =
      "<p>" + t("calc.intro", { route: "<strong>" + tl + "</strong>", vehicle: esc(vehicleLabel(res.vehicle)) }) +
      (real ? " " + esc(t("calc.introReal")) : "") + "</p>" +
      '<div class="table-scroll"><table class="calc-table' + (real ? " is-real" : "") + '">' +
        '<caption class="visually-hidden">' + esc(t("calc.caption", { route: routeLabel(r) })) + "</caption>" +
        '<thead><tr><th scope="col">' + esc(t("calc.road")) + "</th>" + head +
        '<th scope="col" class="num">' + esc(t("calc.distance")) + '</th><th scope="col" class="num">' + esc(t("calc.speed")) + "</th>" +
        '<th scope="col" class="num">' + esc(t("calc.freeTime")) + '</th><th scope="col">' + esc(t("calc.traffic")) + "</th>" +
        '<th scope="col" class="num">' + esc(t("calc.factor")) + '</th><th scope="col" class="num">' + esc(t("calc.estTime")) + "</th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
        '<tfoot><tr><th scope="row" colspan="' + footSpan + '">' + esc(t("calc.total")) + '</th><td class="num">' + fD(r.distanceUnits) +
        '</td><td></td><td class="num">' + fT(r.freeFlowUnits) + '</td><td colspan="2">' + esc(t("calc.delay", { min: fT(r.delayUnits) })) +
        '</td><td class="num">' + fT(r.timeUnits) + "</td></tr></tfoot>" +
      "</table></div>" +
      '<h3 class="calc-sub">' + esc(t("calc.safetyTitle")) + "</h3>" +
      '<div class="table-scroll"><table class="calc-table calc-table-risk">' +
        '<caption class="visually-hidden">' + esc(t("calc.riskCaption", { route: routeLabel(r) })) + "</caption>" +
        '<thead><tr><th scope="col">' + esc(t("calc.road")) + '</th><th scope="col" class="num">' + esc(t("calc.distance")) +
        '</th><th scope="col">' + esc(t("calc.hazards")) + "</th>" +
        '<th scope="col" class="num">' + esc(t("calc.riskPerKm")) + '</th><th scope="col" class="num">' + esc(t("calc.riskScore")) + "</th></tr></thead>" +
        "<tbody>" + riskBody + "</tbody>" +
        '<tfoot><tr><th scope="row">' + esc(t("calc.total")) + '</th><td class="num">' + fD(r.distanceUnits) + '</td><td colspan="2">' +
        esc(t("rating." + r.safety.key)) + '</td><td class="num">' + fR(r.riskUnits) + "</td></tr></tfoot>" +
      "</table></div>" +
      '<div class="calc-notes">' +
        "<h3>" + esc(t("calc.formulaTitle")) + "</h3>" +
        "<p>" + esc(t("calc.formulaTime", { rounding: t(real ? "calc.roundSecond" : "calc.roundTenth") })) + "</p>" +
        "<p>" + esc(t("calc.formulaRisk", { base: D.BASE_RISK, safer: S.saferMaxRisk.toFixed(1), caution: S.cautionMaxRisk.toFixed(1) })) + "</p>" +
        "<h3>" + esc(t(real ? (liveActive() ? "calc.factorsLive" : "calc.factorsEstimated") : "calc.factorsSimulated")) + "</h3><p>" + esc(factors) + ".</p>" +
        "<h3>" + esc(t("calc.speedsTitle")) + "</h3><p>" + esc(speeds) + "." +
        (real ? " " + esc(t("calc.speedsReal")) : "") + " " + esc(t("calc.speedsNote")) + "</p>" +
        "<h3>" + esc(t("calc.vehiclesTitle")) + "</h3><p>" + esc(vehicles) + ".</p>" +
        "<h3>" + esc(t(real ? "calc.hazardsTitleReal" : "calc.hazardsTitleDemo")) + "</h3><p>" + esc(hazardWeights) + ". " +
        esc(real ? t("calc.hazardsReal", { n: BLACKSPOTS.length }) : t("calc.hazardsDemo")) + "</p>" +
        "<h3>" + esc(t("calc.howTitle")) + "</h3>" +
        "<p>" + esc(t(real ? "calc.howGraphReal" : "calc.howGraphDemo", { nodes: D.NODES.length, edges: D.EDGES.length })) + " " +
        esc(t("calc.howDijkstra")) + " " +
        esc(usesPenalty
          ? t("calc.howPenalty", { factor: S.penaltyFactor, rounds: S.penaltyRounds })
          : t("calc.howYen", { k: S.candidatePool })) + " " +
        esc(t("calc.howFilter", { pct: Math.round(S.maxSharedLength * 100) })) + "</p>" +
        "<p>" + esc(t(real ? "calc.howEmergencyReal" : "calc.howEmergencyDemo")) + "</p>" +
        (liveActive() ? "<p>" + esc(t("calc.howLive")) + "</p>" : "") +
        "<p>" + esc(t("calc.label", { light: Math.round((S.lightMaxRatio - 1) * 100), moderate: Math.round((S.moderateMaxRatio - 1) * 100) })) + "</p>" +
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

  els.langOptions.addEventListener("change", function (ev) {
    if (ev.target.value !== lang) setLang(ev.target.value);
  });

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
  els.areaChange.addEventListener("click", function () {
    area.pending = null;
    if (els.areaBox.hidden) openAreaBox();
    else els.areaBox.hidden = true;
  });
  els.areaClose.addEventListener("click", function () { els.areaBox.hidden = true; });
  els.areaSearch.addEventListener("click", searchAreas);
  els.areaQuery.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchAreas();
    }
  });
  els.areaBox.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("[data-area-result],[data-area-key]") : null;
    if (!b) return;
    if (b.hasAttribute("data-area-result")) loadResult(area.results[Number(b.getAttribute("data-area-result"))]);
    else pickSavedArea(b.getAttribute("data-area-key"));
  });

  els.vehicleOptions.addEventListener("change", function (ev) {
    setVehicle(ev.target.value);
  });

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
    if (band) els.hourLabel.textContent = hourText(hour) + " · " + bandName(band);
    clearTimeout(hourTimer);
    hourTimer = setTimeout(function () { setHour(hour); }, 180);
  });

  els.now.addEventListener("click", function () {
    setHour(currentHour());
  });

  els.liveToggle.addEventListener("change", function () {
    setLive(els.liveToggle.checked);
  });
  els.liveRefresh.addEventListener("click", function () { refreshLive(); });
  if (CM) {
    els.reportTypes.innerHTML = CM.TYPES.map(function (type) {
      return '<button type="button" class="area-pick rp-' + type + '" data-report-type="' + type + '" data-i18n="report.type.' + type + '"></button>';
    }).join("");
    applyStaticText();
  }
  els.reportHere.addEventListener("click", function () { els.reportTypes.hidden = !els.reportTypes.hidden; });
  els.reportTypes.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("[data-report-type]") : null;
    if (!b) return;
    els.reportTypes.hidden = true;
    reportHere(b.getAttribute("data-report-type"));
  });
  els.communityList.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("[data-report]") : null;
    if (!b || !community.listed) return;
    var r = community.listed[Number(b.getAttribute("data-report"))];
    if (r && VIEWS.real.focusOn) {
      VIEWS.real.focusOn(r.lat, r.lon);
      els.mapPanel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  });
  setInterval(function () { refreshCommunity(false); }, 15000);
  els.tripStop.addEventListener("click", stopTrip);
  els.tripVoice.addEventListener("change", function () {
    trip.voice = els.tripVoice.checked;
    try { window.localStorage.setItem("trip-voice", trip.voice ? "1" : ""); } catch (err) { /* ignore */ }
    if (trip.voice) speak(els.tripNext.textContent);
  });
  els.tripShare.addEventListener("change", function () {
    trip.share = els.tripShare.checked;
    try { window.localStorage.setItem("trip-share", trip.share ? "1" : ""); } catch (err) { /* ignore */ }
  });
  try {
    els.tripVoice.checked = !!window.localStorage.getItem("trip-voice");
    els.tripShare.checked = !!window.localStorage.getItem("trip-share");
  } catch (err) { /* ignore */ }
  if (CM) {
    els.tripReports.innerHTML = ["accident", "closed", "jam", "flooding"].map(function (type) {
      return '<button type="button" class="area-pick rp-' + type + '" data-trip-report="' + type + '" data-i18n="report.type.' + type + '"></button>';
    }).join("");
  }
  els.tripReports.addEventListener("click", function (ev) {
    var b = ev.target.closest ? ev.target.closest("[data-trip-report]") : null;
    if (b) reportHere(b.getAttribute("data-trip-report"));
  });
  document.addEventListener("visibilitychange", function () { refreshCommunity(false); });
  els.liveIncidents.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-incident]") : null;
    if (!btn || !live.incidents) return;
    var inc = live.incidents.incidents[Number(btn.getAttribute("data-incident"))];
    if (!inc) return;
    var mid = inc.coords[Math.floor(inc.coords.length / 2)];
    if (VIEWS.real.focusOn) VIEWS.real.focusOn(mid.lat, mid.lon);
    els.mapPanel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  });
  setInterval(autoTick, 30000);
  document.addEventListener("visibilitychange", autoTick);
  els.liveKeySave.addEventListener("click", function () {
    var key = els.liveKey.value.trim();
    if (!key) return;
    try { window.localStorage.setItem(KEY_STORE, key); } catch (err) { /* ignore */ }
    els.liveKey.value = "";
    live.error = null;
    els.liveKeyBox.open = false;
    setLive(true);
  });
  els.liveKeyClear.addEventListener("click", function () {
    try { window.localStorage.removeItem(KEY_STORE); } catch (err) { /* ignore */ }
    if (live.on || live.flow || live.incidents) setLive(false);
    live.error = null;
    updateLiveStatus();
  });

  els.scenarioOptions.addEventListener("change", function (ev) {
    var sc = scenarioById(ev.target.value);
    if (!sc) return;
    state.manual = {};
    applyTraffic(E.levelsForScenario(D, sc.id), null, t("cause.scenario", { name: scenarioName(sc) }));
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
    } else if (action === "share") {
      doShare(btn);
    } else if (action === "trip") {
      startTrip();
    } else if (action === "step") {
      var route = state.result && state.result.routes.filter(function (x) { return x.signature === btn.getAttribute("data-sig"); })[0];
      var step = route ? routeSteps(route)[Number(btn.getAttribute("data-step"))] : null;
      if (step && isReal() && VIEWS.real.focusOn) {
        state.focusedSig = route.signature;
        renderMap();
        VIEWS.real.focusOn(step.point.lat, step.point.lon);
        els.mapPanel.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
    } else if (action === "focus") {
      state.focusedSig = btn.getAttribute("data-sig");
      renderMap();
      renderResults();
      var again = els.resultsBody.querySelector('[data-sig="' + state.focusedSig + '"]');
      if (again) again.focus();
    }
  });

  els.reset.addEventListener("click", resetDemo);

  if (VIEWS.real) {
    VIEWS.real.onAction = onMapAction;
    VIEWS.real.t = t;
    VIEWS.real.roadName = roadName;
    VIEWS.real.hazardLabel = hazardLabel;
  }
  if (realAvailable) {
    setupSearch("start");
    setupSearch("destination");
  }

  // ---------- install as an app, work offline ----------

  // The service worker (sw.js) keeps the app's files so it opens offline.
  // Browsers only allow it on https:// pages and on localhost.
  if ("serviceWorker" in navigator && (window.location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname))) {
    navigator.serviceWorker.register("sw.js").catch(function () { /* the app still works online */ });
  }
  var installPrompt = null;
  window.addEventListener("beforeinstallprompt", function (ev) {
    ev.preventDefault();
    installPrompt = ev;
    $("install-app").hidden = false;
  });
  $("install-app").addEventListener("click", function () {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then(function () {
      installPrompt = null;
      $("install-app").hidden = true;
    });
  });
  window.addEventListener("appinstalled", function () { $("install-app").hidden = true; });

  // ---------- start ----------
  var savedLang = null;
  var savedMode = null;
  try {
    savedLang = window.localStorage.getItem("route-lang");
    savedMode = window.localStorage.getItem("route-mode");
  } catch (err) { /* ignore */ }
  var hashLang = /lang=(en|te)/.exec(window.location.hash);
  var hashMode = /mode=(real|demo)/.exec(window.location.hash);
  lang = hashLang ? hashLang[1] : I18N[savedLang] ? savedLang : "en";
  applyStaticText();
  setMode(hashMode ? hashMode[1] : savedMode || (realAvailable ? "real" : "demo"));
  var shared = realAvailable ? sharedTrip() : null;
  if (shared && mode === "real") openShared(shared);
  else restoreArea();
})();
