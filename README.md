# Smart Traffic Route Optimization System for Safer and More Efficient Urban Travel

A Community Service Project software prototype. A road user picks a start and a destination, compares alternative routes by **estimated journey time, distance, traffic and road-safety hazards**, and gets the **fastest** or the **safest** route recommended for their **vehicle** (two-wheeler, car, auto or walking). Traffic follows a **time-of-day slider** or comes **live from TomTom**, an **Emergency** button finds the fastest route to the nearest hospital, and the whole interface works in **English or Telugu (తెలుగు)**.

**Open the app:** <https://tejasreekorimilli23-ctrl.github.io/smart-route-optimizer-/> (works on phones; allow location access for *Use my location*).

It has two modes, switched at the top of the page:

| Mode | What it uses |
| --- | --- |
| **Real map** (default) | The real road network of **Vizianagaram around Thotapalem** from OpenStreetMap: 6,165 junctions, 8,419 road sections, one-way streets and posted speed limits, plus 280 searchable places including 45 hospitals. Shown on a zoomable map. Works with your phone's GPS. |
| **Demo town** | A small invented town (12 places, 19 roads) on a schematic map. Works fully offline. Good for explaining the algorithm in class. |

> **Traffic.** In real-map mode, traffic is estimated from the time of day and the type of road (main roads are jammed at rush hour, roads near schools at school time, markets in the evening). Add your own free TomTom key to switch on **live traffic** for the main roads. Map data can have gaps: always follow road signs, signals and the traffic police.

## Run it

| Option | How |
| --- | --- |
| Easiest | Double-click `index.html` (opens in any modern browser). |
| Local server | `npm start`, then open <http://localhost:5173>. Needs Node.js 18+. Use `PORT=8080 npm start` for another port. |
| Single file | `npm run build` creates `dist/smart-traffic-route-optimizer.html` (about 2.7 MB) with everything inlined, for email or a pen drive. |

**Internet.** Routing works offline in both modes. The real map only needs internet for the background map pictures (OpenStreetMap tiles). Without internet you still see the coloured roads and routes.

**"Use my location".** Browsers only share GPS with pages served over `https://` or from `localhost`. On a laptop, use `npm start`. To use it on a phone, put the folder on any free static host with HTTPS (for example GitHub Pages or Netlify) and open that link on the phone.

## Using the real map

- **Search for places.** Type part of a name in Start or Destination (for example *thota*, *maharaja*, *hospital*) and pick a suggestion with a tap, or with the arrow keys and Enter. The 280 places include areas and junctions, hospitals, schools and colleges, transport, markets, temples and landmarks.
- **Choose your vehicle.** Two-wheeler, car, auto or walking (see *Vehicle types* below).
- **Or click the map.** Clicking anywhere opens a menu: *Start here* or *Go here*. The point is joined to the nearest road, keeping one-way rules, and the route is worked out immediately.
- **Use my location** sets the start to where you are, if you are inside the mapped area.
- **Change traffic on a road.** Click a road, then choose Light, Moderate, Heavy or Closed, for example to mark a road blocked by a procession or road works. The recommendation updates at once.
- **Time of day.** Drag the slider, or press *Use the time now*.
- **Live traffic.** Switch on *Live traffic (TomTom)* once you have added a key (see below).
- **Language.** Press **తెలుగు** at the top for Telugu, **English** to switch back. The choice is remembered on that device.
- **Emergency.** Press *Emergency: nearest hospital*. It searches every hospital (except eye and dental hospitals) and routes to the one with the shortest journey time. It also lists the next two nearest, in case the first cannot treat the emergency. Hospitals show as red **H** markers.

### Two-minute demo (real map)

1. Set the time slider to **12:00 PM**. Start is **Thotapalem**, destination **Vizianagaram Junction** (the railway station). Press **Find Best Route**. Route 1 *via R T C Complex – Thotapalem Road* is fastest, at 5.0 min for 1.5 km. The summary also names the safest route and what it costs in time.
2. Choose **Safest route**. The route with the *Safest* badge becomes Route 1: 5.9 min with a risk score of 3.6, compared with 4.9 for the fastest route. Routes are renamed after their longest road, so its name may change when it moves to the top.
3. Back on **Fastest**, drag the slider to **6:00 PM** (evening rush). The fastest route changes to *via Railway Station Road* (6.5 min), and the notice explains why.
4. Open **How this was calculated** to show the road-by-road time and risk.
5. Press **Emergency: nearest hospital**. From Thotapalem at midday it routes to Tirumala Medicover Hospitals (2.4 min) and lists the next two nearest, with the 108 / 112 helpline numbers.
6. Click any point on the map and choose **Go here** to show routing to an arbitrary place.

## Live traffic (TomTom)

Live traffic is optional and uses your own free TomTom key.

1. Sign up at <https://developer.tomtom.com/> and create an API key. The free plan includes the Traffic API.
2. In the app, open *Traffic conditions → TomTom API key*, paste the key and press **Save**.
3. Live traffic switches on. The status line says when it was updated and how many road sections it covered. Press **Update now** to refresh.

**How it works.**
- The app asks TomTom for the current and free-flow speed at up to 80 points along the main roads. That's 80 requests per update, well inside the free daily allowance.
- Each reading becomes a traffic level: current ÷ free-flow of 0.8 or more is *light*, 0.5 or more is *moderate*, lower is *heavy*, and closed roads are removed.
- Each level is applied to the main-road sections along TomTom's matched stretch of road. Small lanes keep the time-of-day estimate.
- TomTom's live traffic colours are also drawn over the map.

**Your key stays private.** It is stored only in that browser on that device (`localStorage`). It is never written into the project files or sent anywhere except TomTom. *Remove saved key* deletes it. Because the page runs in the browser, anyone using your device can read the key in the developer tools. TomTom lets you restrict a key to your website's address in its dashboard.

## Vehicle types

| Vehicle | Speed | Traffic delay | Other rules |
| --- | --- | --- | --- |
| Car | Road's free-flow speed | Full | Follows one-way streets |
| Two-wheeler | Same, at most 50 km/h | 60% of a car's (filters through jams) | Follows one-way streets |
| Auto | At most 35 km/h | 85% of a car's | Follows one-way streets |
| Walking | Always 4.5 km/h | None | May use one-way streets both ways; no expressways |

## Language

The interface is available in English and Telugu (`js/i18n.js`). Place and road names come from OpenStreetMap and are mostly in English, as on local signboards. The six places that also have a Telugu name in OpenStreetMap can be found by either name.

**The Telugu text was written for this project and should be checked by a native speaker before wider use.** To fix a translation, edit the `te` section of `js/i18n.js`. `npm test` checks that every English text has a Telugu version with the same `{placeholders}`.

## Demo town

### Two-minute demo script (demo town)

1. Switch to **Demo town**. Start is **Bus Station**, destination **Engineering College**. Press **Find Best Route**. Route 1 *via MG Road* is recommended at 13.3 min; Route 2 *via Ring Road* is 1.2 min slower. Point out that MG Road is rated **Higher risk** because of the accident black spot on MG Road (west).
2. Under *Recommend the*, choose **Safest route**. *Via Ring Road* (risk score 10.6, no marked hazards) becomes the recommendation, and the summary says the fastest route would save only 1.2 min. Switch back to **Fastest route**.
3. Drag the **Time of day** slider to **6:00 PM** (evening rush). The fastest route moves to Ring Road. Drag to **9:00 AM**: the *Morning rush* preset lights up, because it is the same traffic.
4. Choose **Morning rush** under *Or choose a scenario*. The notice above the map reports that the recommendation changed to *via Ring Road* (14.5 min) and that the old MG Road route would now take 28.8 min. The cyan band moves on the map.
5. Choose **Off-peak** again. Click **MG Road (east)** on the map (between Clock Tower Junction and Town Hall), then set it to **Moderate**. One road is enough to flip the recommendation.
6. Press **Show on map** on another route card, then open **How this was calculated** to show the road-by-road arithmetic for time and for safety.
7. Set the start to **Railway Station** and press **Emergency: nearest hospital**. The fastest route to Government Hospital is shown, with the 108 / 112 helpline numbers.
8. Error handling: set the destination to **Lake View Colony**, choose **Road works**, and press **Find Best Route**. The app explains that no open road connects them and offers **Reopen closed roads**. Setting start and destination to the same place gives a clear message too.
   Press **Emergency** with the start set to **Lake View Colony** under Road works: the app says no open road reaches a hospital, still shows the helpline numbers, and offers to reopen roads.
9. Press **Start over** to start again.

## How the route is chosen

**Graph model.** The roads form a weighted graph. Places and junctions are nodes; road sections are edges. Edges are two-way unless the road is one-way, in which case they can only be driven in one direction. Each edge has a length, a road type and a traffic level.

**Edge weight (estimated travel time).**

```
free-flow time = distance (km) / free-flow speed (km/h) × 60     rounded once (0.1 min demo, 1 s real map)
estimated time = free-flow time × traffic factor                  rounded the same way
route time     = sum of its roads' estimated times
delay          = route time − route free-flow time
```

| Traffic level | Factor |
| --- | --- |
| Light | ×1.0 |
| Moderate | ×1.6 |
| Heavy | ×2.5 |
| Closed | road removed from the graph |

| Road type (real map) | Assumed free-flow speed |
| --- | --- |
| National highway | 50 km/h |
| Main road (primary) | 40 km/h |
| Secondary road | 35 km/h |
| Local main road (tertiary) | 30 km/h |
| Minor road | 25 km/h |
| Residential street | 20 km/h |
| Service lane | 15 km/h |

Where OpenStreetMap records a lower speed limit for a road, that is used instead. The demo town uses 50 / 35 / 30 / 20 km/h for bypass / arterial / main / local. These are planning assumptions for estimating time, not speed limits.

**Edge weight (safety risk).**

```
risk points per km  = 1 + sum of the road's hazard weights
risk score (road)   = distance (km) × risk points per km
risk score (route)  = sum of its roads' risk scores
```

| Hazard | Extra risk points per km | Real map: where it comes from |
| --- | --- | --- |
| Accident black spot | +3 | Your list in `js/blackspots.js` (see below) |
| School or college zone | +2 | Road within 150 m of a school, college or university |
| Crowded market or shopping area | +2 | Road within 150 m of a market or shopping mall |
| Highway with heavy vehicles | +2 | National highways |
| Busy junction | +1 | Main roads at traffic signals or where two named main roads meet |
| Poor street lighting | +1 | Roads tagged as unlit |
| No footpath for pedestrians | +1 | Roads tagged as having no footpath |

The base 1 point per km means a long detour is not "free": the safest route has to balance distance against hazards. A route's **safety rating** comes from its average risk points per km: up to 1.3 is a *Safer route*, up to 2.0 has *Some hazards*, above that is *Higher risk*.

**Algorithm.**

1. The user chooses **Fastest** or **Safest** and a vehicle. For Fastest, each road is weighted by its estimated time for that vehicle; for Safest, by its risk score.
2. **Dijkstra's algorithm** (with a binary-heap priority queue) finds the best route for that weight. Ties on time go to the shorter distance; ties on risk go to the quicker route; then to location id, so results are fully deterministic.
3. **Alternatives.**
   - **Demo town:** **Yen's k-shortest-paths algorithm** (k = 8) lists the next-best loop-free routes by re-running Dijkstra with parts of earlier routes blocked.
   - **Real map:** the network is too big for Yen's algorithm, which also only finds tiny one-street detours there. The app uses the **penalty method** instead, as many navigation apps do: after each route is found, its roads are made 1.4 times more expensive and Dijkstra runs again (6 rounds). This pushes each search onto genuinely different roads, and each search takes about 0.1–0.2 s.
4. **Distinctness filter.** An alternative is shown only if at most 75% of its length is shared with every route already shown. If that leaves only one route, the next-best is added anyway. At most three routes are shown.
5. The best route under the **other** priority is always included, so the fastest and the safest route can be compared side by side (*Fastest* and *Safest* badges).
6. The **recommendation** is always the true optimum from step 2: lowest time (Fastest) or lowest risk score (Safest). Time and risk are never mixed into a combined score, so the recommendation stays easy to explain.

**Emergency mode.** One Dijkstra search from the start reaches every hospital at once. The hospital with the shortest journey time is chosen, and the next two are listed.

**Time of day.** The slider (6 AM to 10 PM) picks a traffic band: early morning, morning rush, midday, school closing, evening rush and night. In the demo town each band is a fixed set of road levels. On the real map each band is a set of rules by road type and nearby hazard: for example, at 8–10 AM main roads are heavy and roads near schools are heavy. Editing a road switches the slider to *Not in use*.

**Exact numbers.** All times, distances and risk are kept as whole numbers: tenths of a minute and tenths of a km in the demo town, seconds and metres on the real map. Totals are always the exact sum of their roads, and every "X min slower" is an exact difference.

## Real-map data

| Data | Source |
| --- | --- |
| Roads, one-way rules, speed limits, road names | OpenStreetMap, downloaded for the box 18.085–18.140° N, 83.375–83.445° E |
| Places (hospitals, colleges, areas, station, temples…) | OpenStreetMap; each is joined to its nearest road by a short access path |
| Hazards | Worked out from the map (see the table above); black spots from `js/blackspots.js` |
| Traffic | Estimated by time of day and road type (`TIME_BANDS` in `scripts/build-real-network.js`) |

**Accident black spots.** OpenStreetMap does not record them, so `js/blackspots.js` starts empty. Add real ones from the district police, the Road Safety Committee or the MoRTH black spot list, then reload the page. Each entry has a name, latitude, longitude, radius and source. Roads near them get +3 risk points per km and are drawn on the map. Please don't guess.

**Update the map or cover another town.**

```
npm run fetch-map     # downloads OpenStreetMap data into data/osm/ (needs internet)
npm run build-map     # builds js/real-network-data.js from it
```

To cover another place, change the box, centre, name and default route in `scripts/real-area.config.js`, then run both commands.

## Known limitations

- **Live traffic needs your own key, and covers main roads only.** Without a key, traffic is estimated from time of day and road type. With a TomTom key, main roads use live readings and small lanes still use the estimate.
- **Simplified journey times.** They ignore signal waits, turns and vehicle type. Traffic is constant along each road section.
- **Map data gaps.** OpenStreetMap data for smaller towns can miss lanes, have wrong one-way tags, or name places inconsistently. Only the largest connected part of the network is used, so every route found is drivable on the map data.
- **Inferred hazards.** Apart from your black spot list, hazards are worked out from the map, not from accident records.
- **No hospital capabilities.** Emergency mode plans a route only. It does not know which hospitals have a 24-hour casualty department, and it does not call for help. The helpline numbers shown (108 ambulance, 112 emergency) are for India.
- **Area limits.** The real map covers the box above. Points more than 400 m from any road in it are refused.

## Tests

```
npm run check         # syntax of every JS file; page ids and file references are consistent
npm test              # algorithm tests for both modes (Node's built-in test runner, no dependencies)
npm run build         # builds the single-file version
npm run verify        # all three
```

**Demo town.** For every start–destination pair under every scenario and every hour, for both Fastest and Safest (5,544 queries), the recommendation is compared against a brute-force search of every possible path. The tests check badges, valid paths, no closed roads, no duplicates, and that every total and difference adds up exactly. Emergency is checked against brute force from every place.

**Vehicles.** For every pair of places and every vehicle type, the recommendation is checked against brute force.

**Live traffic** (with a fake TomTom server, no key needed). The tests check:
- sample points;
- speed-to-level rules;
- matching readings to road sections;
- error handling: wrong key, daily limit, no answer, a browser that throws.

**Translations.** Every text key used by the page exists in English and Telugu, with the same placeholders.

**Real map.**
- The data is consistent: geometry matches junctions, and every place can reach every other place respecting one-way streets.
- Walking may use one-way streets both ways; vehicles may not.
- Sample routes across the town at 9 AM, 12 PM and 6 PM, for both priorities, are the true optimum (checked against a separate Dijkstra run), drivable (no wrong-way driving, no closed roads), add up exactly, and are fast enough.
- Closing a road makes routes avoid it.
- Emergency picks the hospital with the shortest journey time.
- GPS and map-click pins work, and points outside the area are refused.
- Black spots are applied correctly.
- The committed map file matches a fresh build from the downloaded data.

Optional end-to-end browser test (drives the real page in headless Chromium and saves screenshots to `tests/screenshots/`):

```
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

## Project structure

```
index.html                     Page structure
css/styles.css                 Styles (responsive, light and dark themes)
css/vendor/leaflet.css         Leaflet map library styles
js/vendor/leaflet.js           Leaflet 1.9.4 map library (BSD-2, see LEAFLET-LICENSE.txt)
js/network-data.js             Demo town: network, road types, traffic levels, hazards, scenarios, time bands
js/real-network-data.js        Real map: GENERATED from OpenStreetMap by npm run build-map
js/blackspots.js               Accident black spots for the real map (edit this)
js/route-engine.js             Algorithm: Dijkstra, Yen's k-shortest paths, penalty method, safety risk, vehicles, emergency
js/live-traffic.js             Live traffic from TomTom (optional, your own key)
js/place-search.js             Type-ahead place search box
js/i18n.js                     Interface text in English and Telugu
js/geo-tools.js                Pinning GPS / map clicks to the nearest road; applying black spots
js/map-view.js                 Demo town: SVG schematic map drawing
js/real-map-view.js            Real map: Leaflet map drawing and click menus
js/app.js                      UI: controls, rendering, events, mode switch
scripts/real-area.config.js    Real map area settings
scripts/fetch-osm.js           Downloads OpenStreetMap data into data/osm/
scripts/build-real-network.js  Turns the download into js/real-network-data.js
scripts/serve.js               Zero-dependency local server
scripts/check.js               Static checks
scripts/build-single-file.js
data/osm/                      The OpenStreetMap download the real map was built from
tests/route-engine.test.js     Algorithm tests (demo town)
tests/real-network.test.js     Real map tests
tests/live-traffic.test.js     Live traffic tests (fake TomTom server)
tests/i18n.test.js             English / Telugu text checks
tests/browser-smoke.cjs        Optional browser test
```

The algorithm (`route-engine.js`) has no browser dependencies and is tested directly in Node. The UI only displays what the engine returns.

## Credits and licences

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available under the Open Database License (ODbL). The attribution must stay visible on the map.
- Map tiles from the OpenStreetMap tile servers, used under their [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). That is fine for a class project. A public service with many users should use its own tile provider.
- [Leaflet](https://leafletjs.com/) 1.9.4, BSD-2-Clause licence (`js/vendor/LEAFLET-LICENSE.txt`).
- Live traffic data © TomTom, used with your own key under TomTom's terms.
- Telugu text uses the Noto Sans Telugu font from Google Fonts. Offline, the phone's own Telugu font is used.

## Road safety

Choosing a less congested route saves time by avoiding traffic. It never means driving faster. Route suggestions support better travel decisions; they do not prevent accidents. Road signs, signals and traffic police instructions always come first.
