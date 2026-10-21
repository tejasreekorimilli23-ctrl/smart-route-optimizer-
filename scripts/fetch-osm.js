/*
 * Downloads the road network and places for the real-map area from
 * OpenStreetMap (Overpass API) into data/osm/. Needs internet and Node 18+.
 *     npm run fetch-map
 * Then run: npm run build-map
 *
 * Map data © OpenStreetMap contributors, available under the Open Database
 * License (ODbL). Please keep the attribution shown on the map.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const AREA = require("./real-area.config.js");

const OUT = path.resolve(__dirname, "..", "data", "osm");
const ENDPOINT = "https://overpass-api.de/api/interpreter";

const { queries } = require("../js/osm-network.js");
const { roads: ROADS, places: PLACES } = queries(AREA.bbox);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POSTs a query, retrying a few times: the public server is often busy. */
async function overpass(query) {
  const tries = 4;
  for (let i = 1; ; i++) {
    let problem;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "smart-traffic-route-optimizer (student community service project)"
        },
        body: "data=" + encodeURIComponent(query)
      });
      if (res.ok) return await res.text();
      problem = "HTTP " + res.status;
    } catch (err) {
      problem = err.message;
    }
    if (i === tries) throw new Error("Overpass failed (" + problem + "). Wait a few minutes and try again.");
    process.stdout.write("(" + problem + ", retrying in " + 15 * i + " s) ");
    await wait(15000 * i);
  }
}

async function download(name, query) {
  process.stdout.write("Downloading " + name + "... ");
  const text = await overpass(query);
  const json = JSON.parse(text);
  fs.writeFileSync(path.join(OUT, name + ".json"), text);
  console.log(json.elements.length + " elements");
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await download("roads", ROADS);
  await download("places", PLACES);
  fs.writeFileSync(
    path.join(OUT, "meta.json"),
    JSON.stringify({ downloaded: new Date().toISOString(), bbox: AREA.bbox, source: ENDPOINT }, null, 2)
  );
  console.log("Saved to " + path.relative(process.cwd(), OUT) + ". Next: npm run build-map");
})().catch((err) => {
  console.error("Download failed: " + err.message);
  process.exit(1);
});
