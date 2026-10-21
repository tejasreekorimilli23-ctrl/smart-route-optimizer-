/*
 * Accident black spots for the real map. Edit this list, then reload the page.
 *
 * OpenStreetMap does not record accident black spots, so this list starts
 * empty. Fill it from a trustworthy source: the district police / Road Safety
 * Committee, the Ministry of Road Transport and Highways (MoRTH) black spot
 * list, or a local survey you did for the project. Do not guess.
 *
 * Every road section within radiusMetres of a black spot gets the
 * "Accident black spot" hazard (+3 risk points per km), so the Safest route
 * avoids it when it can. Black spots are also drawn on the map.
 *
 * Example (made-up position, NOT a real black spot):
 *   { name: "Example junction", lat: 18.1100, lon: 83.4000, radiusMetres: 100, source: "District police, 2025" }
 */
(function (root) {
  "use strict";
  root.BLACKSPOTS = [
    // { name: "", lat: 0, lon: 0, radiusMetres: 100, source: "" },
  ];
})(typeof self !== "undefined" ? self : this);
