/*
 * Settings for the real-map mode. Change these to cover another town, then:
 *     npm run fetch-map    (downloads OpenStreetMap data into data/osm/)
 *     npm run build-map    (builds js/real-network-data.js from it)
 */
"use strict";

module.exports = {
  areaName: "Vizianagaram (around Thotapalem)",
  // south, west, north, east (degrees). About 6 km x 7 km around the town centre.
  bbox: [18.085, 83.375, 18.140, 83.445],
  center: [18.1035, 83.4022], // Thotapalem
  zoom: 15,

  // Default route shown in the planner (place names as built; first match wins).
  defaultOrigin: "Thotapalem",
  defaultDestination: "Vizianagaram Junction",

  // A place further than this from any road is left out.
  snapMaxMetres: 300,
  // Roads within this distance of a school/college or a market get that hazard.
  schoolZoneMetres: 150,
  marketZoneMetres: 150,

  // Places that are not tagged as points in OpenStreetMap but should be searchable.
  extraPlaces: []
};
