/*
 * Sample road network and simulated traffic scenarios.
 *
 * Everything in this file is ILLUSTRATIVE demo data for a classroom
 * prototype. Place names are generic town landmarks, distances and speeds are
 * invented but fixed, and the x/y values are schematic diagram positions, not
 * GPS coordinates. Nothing here is real-time or real-world traffic data.
 *
 * Works in the browser (exposes window.TrafficData) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TrafficData = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Free-flow speed assumptions per road type (km/h). Used only to estimate
  // journey time; they are not speed limits.
  var ROAD_TYPES = {
    bypass: { label: "Bypass", freeFlowKmh: 50 },
    arterial: { label: "Arterial road", freeFlowKmh: 35 },
    main: { label: "Main road", freeFlowKmh: 30 },
    local: { label: "Local street", freeFlowKmh: 20 }
  };

  // Simulated congestion levels. A road's estimated time is its free-flow
  // time multiplied by the delay factor. "closed" removes the road.
  var CONGESTION_LEVELS = {
    light: { label: "Light", factor: 1.0 },
    moderate: { label: "Moderate", factor: 1.6 },
    heavy: { label: "Heavy", factor: 2.5 },
    closed: { label: "Closed", factor: null }
  };
  var CONGESTION_ORDER = ["light", "moderate", "heavy", "closed"];

  // Simulated road-safety hazards. Every kilometre driven counts as
  // BASE_RISK risk points; each hazard on a road adds its weight per km.
  // Weights are classroom assumptions, not accident statistics.
  var BASE_RISK = 1;
  var HAZARDS = {
    blackspot: { label: "Accident black spot", weight: 3 },
    school: { label: "School zone", weight: 2 },
    market: { label: "Crowded market area", weight: 2 },
    unlit: { label: "Poor street lighting", weight: 1 },
    nofootpath: { label: "No footpath for pedestrians", weight: 1 }
  };
  var HAZARD_ORDER = ["blackspot", "school", "market", "unlit", "nofootpath"];

  // Locations (graph nodes). x/y are positions on a 1000 x 640 schematic.
  var NODES = [
    { id: "RLY", name: "Railway Station", x: 110, y: 95 },
    { id: "SCH", name: "Govt. High School", x: 285, y: 190 },
    { id: "MKT", name: "Market Square", x: 440, y: 110 },
    { id: "HSP", name: "Government Hospital", x: 700, y: 95, kind: "hospital" },
    { id: "BUS", name: "Bus Station", x: 120, y: 330 },
    { id: "CLK", name: "Clock Tower Junction", x: 440, y: 330 },
    { id: "TWN", name: "Town Hall", x: 660, y: 330 },
    { id: "COL", name: "Engineering College", x: 868, y: 250 },
    { id: "RNG", name: "Ring Road Junction", x: 270, y: 520 },
    { id: "IND", name: "Industrial Estate", x: 590, y: 545 },
    { id: "STD", name: "Sports Stadium", x: 840, y: 460 },
    { id: "LKV", name: "Lake View Colony", x: 925, y: 590 }
  ];

  // Roads (graph edges). Two-way. distanceKm uses one decimal place.
  // "corridor" groups road sections that belong to the same named road; it
  // is used only for friendly route names such as "via MG Road".
  var EDGES = [
    { id: "e01", from: "RLY", to: "BUS", name: "Station Road", corridor: "Station Road", type: "main", distanceKm: 2.2, hazards: [] },
    { id: "e02", from: "RLY", to: "SCH", name: "School Lane", corridor: "School Lane", type: "local", distanceKm: 1.4, hazards: ["school"] },
    { id: "e03", from: "SCH", to: "MKT", name: "Bazaar Street", corridor: "Bazaar Street", type: "local", distanceKm: 1.6, hazards: ["market", "nofootpath"] },
    { id: "e04", from: "SCH", to: "CLK", name: "Temple Street", corridor: "Temple Street", type: "local", distanceKm: 1.6, hazards: ["school", "unlit"] },
    { id: "e05", from: "BUS", to: "CLK", name: "MG Road (west)", corridor: "MG Road", type: "arterial", distanceKm: 2.6, hazards: ["blackspot"] },
    { id: "e06", from: "MKT", to: "CLK", name: "Market Link Road", corridor: "Market Link Road", type: "local", distanceKm: 1.3, hazards: ["market"] },
    { id: "e07", from: "MKT", to: "HSP", name: "Hospital Road", corridor: "Hospital Road", type: "main", distanceKm: 2.7, hazards: [] },
    { id: "e08", from: "CLK", to: "TWN", name: "MG Road (east)", corridor: "MG Road", type: "arterial", distanceKm: 2.2, hazards: [] },
    { id: "e09", from: "HSP", to: "TWN", name: "Collectorate Road", corridor: "Collectorate Road", type: "local", distanceKm: 1.6, hazards: [] },
    { id: "e10", from: "HSP", to: "COL", name: "College Road", corridor: "College Road", type: "main", distanceKm: 2.6, hazards: [] },
    { id: "e11", from: "TWN", to: "COL", name: "University Avenue", corridor: "University Avenue", type: "main", distanceKm: 2.5, hazards: [] },
    { id: "e12", from: "BUS", to: "RNG", name: "Ring Road (north)", corridor: "Ring Road", type: "bypass", distanceKm: 2.4, hazards: [] },
    { id: "e13", from: "CLK", to: "RNG", name: "Gandhi Nagar Road", corridor: "Gandhi Nagar Road", type: "local", distanceKm: 2.1, hazards: ["unlit", "nofootpath"] },
    { id: "e14", from: "RNG", to: "IND", name: "Ring Road (south)", corridor: "Ring Road", type: "bypass", distanceKm: 3.2, hazards: [] },
    { id: "e15", from: "TWN", to: "IND", name: "Industrial Link", corridor: "Industrial Link", type: "main", distanceKm: 2.6, hazards: ["blackspot"] },
    { id: "e16", from: "IND", to: "STD", name: "Bypass Road", corridor: "Bypass Road", type: "bypass", distanceKm: 2.7, hazards: [] },
    { id: "e17", from: "STD", to: "COL", name: "Stadium Road", corridor: "Stadium Road", type: "main", distanceKm: 2.3, hazards: [] },
    { id: "e18", from: "TWN", to: "STD", name: "Park Street", corridor: "Park Street", type: "local", distanceKm: 2.4, hazards: [] },
    { id: "e19", from: "STD", to: "LKV", name: "Lake Bridge", corridor: "Lake Bridge", type: "main", distanceKm: 1.4, hazards: ["nofootpath"] }
  ];

  // Predefined, reproducible traffic scenarios. Roads not listed are "light".
  var SCENARIOS = [
    {
      id: "offpeak",
      name: "Off-peak",
      description: "Quiet roads. Only the bazaar is a little busy.",
      levels: { e03: "moderate" }
    },
    {
      id: "rush",
      name: "Morning rush",
      description: "School and office traffic jams MG Road and nearby streets.",
      levels: {
        e05: "heavy", e08: "heavy", e01: "moderate", e02: "heavy",
        e04: "moderate", e11: "moderate", e10: "moderate", e03: "moderate"
      }
    },
    {
      id: "market",
      name: "Market day",
      description: "Shoppers crowd the market streets and Hospital Road.",
      levels: { e03: "heavy", e06: "heavy", e07: "moderate", e08: "moderate", e04: "moderate" }
    },
    {
      id: "roadworks",
      name: "Road works",
      description: "Bypass Road and Lake Bridge are closed for repairs.",
      levels: { e16: "closed", e19: "closed", e14: "moderate", e05: "moderate", e08: "moderate" }
    }
  ];

  // Simulated traffic through the day, for the time-of-day slider.
  // Each band covers whole hours from "from" to "to" inclusive. A band either
  // reuses a scenario's levels or lists its own; roads not listed are "light".
  var DAY_START_HOUR = 6;
  var DAY_END_HOUR = 22;
  var TIME_BANDS = [
    { from: 6, to: 7, name: "Early morning", description: "Roads are clear before the day starts.", levels: {} },
    { from: 8, to: 10, name: "Morning rush", description: "School and office traffic jams MG Road and nearby streets.", scenario: "rush" },
    { from: 11, to: 15, name: "Midday", description: "Quiet roads. Only the bazaar is a little busy.", scenario: "offpeak" },
    {
      from: 16, to: 16, name: "School closing",
      description: "Schools let out: the lanes near Govt. High School fill up.",
      levels: { e02: "heavy", e04: "heavy", e03: "moderate", e05: "moderate" }
    },
    {
      from: 17, to: 19, name: "Evening rush",
      description: "Factory shifts end and shoppers head to the market. Industrial Link and MG Road (west) are jammed.",
      levels: { e15: "heavy", e05: "heavy", e08: "moderate", e14: "moderate", e13: "moderate", e03: "heavy", e06: "moderate", e07: "moderate" }
    },
    { from: 20, to: 22, name: "Night", description: "Light traffic after dark.", levels: {} }
  ];

  var DEFAULTS = { origin: "BUS", destination: "COL", scenarioId: "offpeak", hour: 12, priority: "fastest" };

  return {
    ROAD_TYPES: ROAD_TYPES,
    CONGESTION_LEVELS: CONGESTION_LEVELS,
    CONGESTION_ORDER: CONGESTION_ORDER,
    BASE_RISK: BASE_RISK,
    HAZARDS: HAZARDS,
    HAZARD_ORDER: HAZARD_ORDER,
    DAY_START_HOUR: DAY_START_HOUR,
    DAY_END_HOUR: DAY_END_HOUR,
    TIME_BANDS: TIME_BANDS,
    NODES: NODES,
    EDGES: EDGES,
    SCENARIOS: SCENARIOS,
    DEFAULTS: DEFAULTS
  };
});
