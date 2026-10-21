/*
 * Service worker: lets the planner open and work without internet.
 *
 *  - The app's own files (page, styles, scripts, the built-in map) are
 *    fetched fresh from the network when online, and kept in a cache so they
 *    still load offline ("network first").
 *  - Map pictures (OpenStreetMap tiles) you have looked at are kept too, up
 *    to MAX_TILES, so recently seen streets show offline ("cache first").
 *  - Live services (TomTom, Firebase, OpenStreetMap search and downloads)
 *    are never cached: they must be current. Downloaded towns are kept by
 *    the app itself (IndexedDB), not here.
 */
"use strict";

var APP_CACHE = "route-app-v1";
var TILE_CACHE = "route-tiles-v1";
var MAX_TILES = 800;
var APP_FILES = [
  "./", "index.html", "manifest.webmanifest",
  "css/styles.css", "css/vendor/leaflet.css",
  "js/vendor/leaflet.js", "js/i18n.js", "js/network-data.js", "js/real-network-data.js", "js/osm-network.js",
  "js/area-loader.js", "js/blackspots.js", "js/route-engine.js", "js/geo-tools.js", "js/live-traffic.js",
  "js/firebase-config.js", "js/community.js", "js/translit.js", "js/place-search.js", "js/directions.js",
  "js/trip.js", "js/map-view.js", "js/real-map-view.js", "js/app.js",
  "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", function (ev) {
  ev.waitUntil(caches.open(APP_CACHE).then(function (c) { return c.addAll(APP_FILES); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener("activate", function (ev) {
  ev.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== APP_CACHE && k !== TILE_CACHE; }).map(function (k) {
      return caches.delete(k);
    }));
  }).then(function () { return self.clients.claim(); }));
});

function trimTiles() {
  return caches.open(TILE_CACHE).then(function (c) {
    return c.keys().then(function (keys) {
      var extra = keys.length - MAX_TILES;
      return Promise.all(keys.slice(0, Math.max(0, extra)).map(function (k) { return c.delete(k); }));
    });
  });
}

self.addEventListener("fetch", function (ev) {
  var req = ev.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Map tiles: cache first, then network.
  if (url.hostname === "tile.openstreetmap.org") {
    ev.respondWith(caches.open(TILE_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res.ok || res.type === "opaque") {
            c.put(req, res.clone());
            trimTiles();
          }
          return res;
        });
      });
    }));
    return;
  }

  // The app's own files: network first, cache as a fallback (also fonts).
  if (url.origin === self.location.origin || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    ev.respondWith(fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(APP_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: url.origin === self.location.origin }).then(function (hit) {
        return hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
      });
    }));
  }
  // Everything else (TomTom, Firebase, Overpass, Nominatim): straight to the network.
});
