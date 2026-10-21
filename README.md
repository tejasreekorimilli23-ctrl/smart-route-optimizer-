# Smart Traffic Route Optimization System for Safer and More Efficient Urban Travel

A Community Service Project web application. A road user picks a start and a destination in **any town**, compares alternative routes by **journey time, distance, traffic and road-safety hazards**, and gets the **fastest** or the **safest** route for their **vehicle** (two-wheeler, car, auto or walking).

**Main features**
- **Turn-by-turn directions** and **Trip mode**, which follows your GPS, gives voice guidance and re-routes when you go off the route.
- **Today's real situation.** The app finds out about accidents, closures, bandhs and jams from four sources:
  - live TomTom traffic and incidents;
  - **reports from people**;
  - **official alerts** from the police or municipality;
  - **speeds shared anonymously** by travellers.
- **Emergency:** the nearest hospital by travel time.
- **Share a route** by link or WhatsApp.
- **Install it** on your phone and **use it offline**.
- **Everything in English or Telugu (తెలుగు)**, including place names.

**Open the app:** <https://tejasreekorimilli23-ctrl.github.io/smart-route-optimizer-/> (works on phones; allow location access for *Use my location*).

It has two modes, switched at the top of the page:

| Mode | What it uses |
| --- | --- |
| **Real map** (default) | The real road network of **any town you choose** (built in: **Vizianagaram around Thotapalem**) from OpenStreetMap: 6,165 junctions, 8,419 road sections, one-way streets and posted speed limits, plus 280 searchable places including 45 hospitals. Shown on a zoomable map. Works with your phone's GPS. |
| **Demo town** | A small invented town (12 places, 19 roads) on a schematic map. Works fully offline. Good for explaining the algorithm in class. |

> **Traffic.** In real-map mode, traffic is estimated from the time of day and the type of road (main roads are jammed at rush hour, roads near schools at school time, markets in the evening). Add your own free TomTom key to switch on **live traffic** for the main roads. Map data can have gaps: always follow road signs, signals and the traffic police.

## Run it

| Option | How |
| --- | --- |
| Easiest | Double-click `index.html` (opens in any modern browser). |
| Local server | `npm start`, then open <http://localhost:5173>. Needs Node.js 18+. Use `PORT=8080 npm start` for another port. |
| Single file | `npm run build` creates `dist/smart-traffic-route-optimizer.html` (about 1.2 MB) with everything inlined, for email or a pen drive. |

**Internet.** Routing works offline in both modes. The real map needs internet for:
- the background map pictures (OpenStreetMap tiles);
- downloading a new town;
- live data (TomTom, reports, alerts).

**Install as an app and use offline.**
- On a phone, open the site (it must be `https://`, for example GitHub Pages) and press **⬇ Install app**, or use the browser menu: *Add to Home screen*.
- A service worker (`sw.js`) keeps the app's files, so it opens without internet. It also keeps the map pictures you have looked at (up to 800). Towns you loaded are kept by the app itself.
- Tested: with the server switched off, the app still opened, loaded a saved town and found routes and the nearest hospital.
- Live services are never cached, because they must be current.

**"Use my location".** Browsers only share GPS with pages served over `https://` or from `localhost`. On a laptop, use `npm start`. To use it on a phone, put the folder on any free static host with HTTPS (for example GitHub Pages or Netlify) and open that link on the phone.

## Any town, not only Vizianagaram

Vizianagaram is built in, but the real map works for any town or locality, in India or elsewhere:

1. Press **Change area** (above *Start*).
2. Type a town, city or locality, for example *Srikakulam*, *Gajuwaka* or *Guntur*, and press **Search**.
3. Pick the right place from the list.
4. The app downloads that area's roads and places from OpenStreetMap, builds the road network on your device, checks it, and switches the map and the routing to it.

**What you see while it loads.** Downloading (roads and places at the same time) → building the road network → checking that it is connected and routable → ready. While it loads, Start, Destination and *Find Best Route* are greyed out, so nothing is calculated on the old map. If it fails, the real reason is shown (servers busy, no internet, hardly any roads, not connected), the old area stays, and **Try again** repeats the same download.

**How big an area is.**
- A town whose outline is up to about 12 × 12 km (150 km²) is loaded whole.
- Anything bigger, such as a whole city (Visakhapatnam is about 35 × 34 km), is too much for a phone: about 8 × 8 km around its centre is loaded, and the area line under *Area:* says so.
- When **both ends of a trip** are chosen, the area covers both (up to about 12 × 12 km / 150 km² in total). This is how trips across a city work: for example Pothinamallayyapalem → Hanumanthuwaka in Visakhapatnam (5.3 km apart) load as one 13 × 7 km area.
- Longer trips (for example Vizianagaram → Visakhapatnam, about 45 km) are refused with a clear message: this is a town-level planner; inter-city routing would need a routing server.

**Getting a trip into one area.** Any of these load an area that covers both ends when they fit:
- In Start or Destination, type a place that isn't on the map and choose **Search "…" outside this area**.
- Click or tap a point outside the map (or drag a pin there): the app offers **Load one area covering both**, or **Load the roads around this point**.
- **Change area** with a start already chosen (for example by GPS): the searched place becomes the destination when both fit; otherwise the start is cleared and the app says why.
- **Use my location** outside the map keeps a chosen destination when both fit.

The first download of an area usually takes 40–90 seconds, depending on how busy the free OpenStreetMap servers are; the app tries three servers and tells you when it is retrying. After that, the area is **kept on the device** and opens at once, even offline. The last four areas you used are kept. *Areas on this device* lets you switch between them, or back to the built-in Vizianagaram. The line under *Area:* shows whether the map is built in, downloaded just now, or saved (with its download date), its size, and its number of junctions, road sections and places, counted from the data.

**One area at a time, no mixing.** Only the newest area request counts: if you search a city while "Use my location" is still loading, the older download is ignored when it finishes. Road ids are generated per area, so the same id is a different road in another area (the tests found over 100 such clashes between two areas built from the same data). Therefore:
- live TomTom answers that arrive after you switched area are thrown away;
- reports from people are placed on the current map's road nearest to where they were made (within 80 m), never by id;
- official alerts carry their area and the middle point of each closed road, and are matched by position (within 15 m) on other areas; older alerts without that information only apply on the built-in map, where they were made;
- shared trip speeds are tagged with their area and only used on the same area.

Everything works the same in every area: fastest and safest routes, vehicle types, directions, emergency (nearest hospital), live TomTom traffic and incidents, and Telugu.

## Leaving time, saved places, accounts and the dashboard

**Departure date and time.** *Leaving at* is filled in automatically from the device's clock and moves on by itself every 30 seconds while *Now* is ticked; the traffic estimate follows to the next hour on its own. Untick *Now* (or pick a date and time) to plan a later trip: the estimate uses that hour, results say "Leaving Thursday 8:30 AM, you arrive about 8:37 AM", and TomTom long routes use predicted traffic for that time. The estimate covers 6 AM–10 PM and does not tell weekdays from weekends.

**Saved places and recent destinations.** *☆ Save this destination* keeps a place; tapping into an empty Start or Destination box lists saved places and the last 8 destinations. Choosing one outside the loaded map offers to load an area or plan a long-distance route.

**Accounts (optional): Sign in / Sign up** at the top of the page. With an account (Firebase Authentication, email + password), saved places, recent destinations and trip history are kept in the user's own Firestore document and come back on any device; *Forgot password?* sends Firebase's reset email. Without an account everything works on the device. Setup: Firebase console → Authentication → Email/Password enabled (already done for the admin page) and the new `users/{uid}` rule in `firestore.rules` published. Nobody else, admins included, can read a user's document. The admin sign-in on admin.html is separate.

**Live position.** *Show me moving on the map* follows the GPS (one watcher; stops when pressed again or when Trip mode starts).

**Theme.** The theme button switches auto (follows the phone) → light → dark, and remembers the choice.

**Tolls.** *Avoid toll roads where supported* works for long routes with TomTom (`avoid=tollRoads`). The OpenStreetMap data of the areas has no toll roads, and the free OpenStreetMap routing service rejects toll exclusion, so the page says when tolls could not be avoided.

**Trip analytics (under the routes).**
- *Routes compared*: distance, time, no-traffic time, delay, share in heavy traffic, risk, fuel and CO₂ for each route.
- *Time saved by using traffic information*: against a clearly defined baseline, the route a planner without traffic data would pick (quickest with all roads empty), timed under today's conditions.
- *Traffic along the recommended route*: light / moderate / heavy shares by length, with the data source.
- *Travel time by departure hour*: a bar chart for 6 AM–10 PM from the time-of-day estimates (best time to leave), plus a *reliability* rating from the spread of those times, or from the user's own recorded trips once there are 3.
- *How the estimate changed*: every new estimate this session (live data, reports, time changes) as a line chart.
- *Your recorded trips*: Trip mode keeps how long each trip really took; with 2 or more on the same route, their median is shown as a prediction next to the estimate.
- *Fuel and emissions*: litres = km ÷ typical mileage (car 15, auto 25, two-wheeler 45 km/l) + idling 0.8 / 0.5 / 0.25 l per hour of delay; CO₂ = 2.31 kg per litre. A planning estimate.
- *Download report (CSV)* and *Print or save as PDF* for project evaluation.

**Admin analytics** (admin.html): counts of active reports by type, road and hour, active alerts, and shared speeds per road (number of readings and median speed) for the chosen area. Only aggregates are shown: no reporter, position or trip.

**Downloads that look stuck.** The free Overpass servers allow about 2 downloads at a time per internet connection and answer "too many requests" (HTTP 429) beyond that. The app now stops a download as soon as the user cancels or chooses another place (so it frees its slot), waits at least 20 s after a 429, shows each new attempt ("attempt 3 / 6"), highlights the chosen place with *loading…* and offers *Cancel*.

## Long-distance trips (between towns)

The app's own road map and Dijkstra work inside one downloaded area (at most about 12 × 12 km); a phone cannot download and hold the road network between two cities. When the two ends of a trip are too far apart for one area, the route comes from a **routing service** instead, and the page says so:

| | TomTom Routing API | OpenStreetMap routing (FOSSGIS OSRM) |
| --- | --- | --- |
| Used when | a TomTom key is saved (the same key as live traffic; the Routing API must be enabled for it) | no key, or TomTom fails (the page shows why) |
| Traffic | live and typical traffic, delay shown | none: typical speeds from OpenStreetMap |
| Alternatives | up to 2 | when the service finds them |
| Vehicles | car, motorcycle (two-wheeler), pedestrian; autos as car | car and foot profiles |

What the app still does itself: it ranks the service's candidate routes by your objective (fastest / shortest / safest), caps speeds for autos (35 km/h) and two-wheelers (50 km/h) as on the local map, and gives a **limited safety score**: 1 point per km plus 2 per km on national highways (the local model's heavy-vehicle weight). Schools, markets, junctions, reports and alerts are only known inside a downloaded area, so this is a rough comparison, not a rating. Trip mode with re-routing works on downloaded areas; for long routes, follow the directions.

**How to start one.** Any of these, when the two ends are too far apart for one area:
- *Use my location*, with a destination already chosen;
- type the destination in *Destination*, choose **Search "…" outside this area**, and pick the place;
- tap a far point on the map, and press **Plan a long-distance route**.

**Place search.** OpenStreetMap's Nominatim first; if it finds nothing, the same words with "&" for "and" (OpenStreetMap names *Lendi Institute of Engineering **&** Technology* that way, so the full name with "and" found nothing before); then Photon (komoot), which allows small spelling differences. All three use OpenStreetMap data; full addresses are listed to choose from.

**Tested with the real services:** a (simulated) GPS position in Visakhapatnam to Lendi Institute of Engineering & Technology, Jonnada: the full name was found, and OpenStreetMap routing returned 41.9 km, about 40 min by car via Old NH16 and NH16, in about 1.5 s; the route is drawn on the map. A request to TomTom with an invalid key got HTTP 401, and the page said so and used OpenStreetMap routing instead. Not tested: TomTom routing with a valid key (no key was available).

**Fair use.** The FOSSGIS routing service and Photon are free, shared services: the app sends one request per plan, never in a loop. A public service with many users should run its own routing server or use a paid API.

**Tested in the browser with the real OpenStreetMap servers:**
- Srikakulam: searched, downloaded and routed (3,938 junctions, 201 places, 56 hospitals).
- Visakhapatnam (city centre): downloaded and built in 56 s; 4,400 junctions, 6,389 road sections, 399 places; route Old Post Office area → RK Beach (5.6 min via Beach Road); the "only the centre is covered" note was shown.
- The bug-report trip: a start at Pothinamallayyapalem, outside that map, offered *Load one area covering both*; the 13 × 7 km area (8,403 junctions, 12,361 road sections) loaded in 43 s; then Pothinamallayyapalem → Hanumanthuwaka gave 3 routes (fastest 15.0 min, 8.3 km via Old NH16).
- Switching Visakhapatnam → built-in Vizianagaram → saved Visakhapatnam: each area routed on its own roads, and the saved one showed its download date after a reload.
- Choosing Srikakulam and then, 2 s later, Visakhapatnam: only Visakhapatnam was ever shown.

**Limits.** An area is at most about 12 × 12 km (150 km²). Very large, dense areas take longer to download. Routes between towns far apart are not supported.

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

## Directions and Trip mode

Every route card has **Directions**, for example "Head west on … for 140 m", "Turn left onto R T C Complex Road for 270 m", "Arrive at Vizianagaram Junction". Tap a step to see it on the map.

**Trip mode.** On the route shown on the map, press **▶ Start trip**.
- **Following:** the app follows your GPS (a blue dot) and keeps the map centred.
- **Next turn:** shows the next turn ("In 200 m: Turn left onto …"), the time and distance left, and your arrival time.
- **Voice guidance** (optional): reminders at 200 m and 50 m before each turn. Telugu voice works if the phone has a Telugu text-to-speech voice; otherwise switch to English.
- **Re-routing:** if you leave the route (two GPS positions in a row more than 50 m away), it plans again from where you are. If a new accident, closure or jam changes the best route while you travel, it follows the new one.
- **Quick reports** (Accident, Road closed, Traffic jam, Flooding) send a report at your position.
- **Share my speed anonymously** (optional, off by default, never on foot): your measured speed on each road section is shared, so the app can spot jams from real travellers. Only the road, speed, vehicle type and time are sent, with no name, phone or trip.
- The screen stays on during the trip where the browser allows it.

## Share a route

Under the route summary, use **Share route** (the phone's share menu, or copy the link) or **Send on WhatsApp**.
- **What the link carries:** both places (by position and name), the vehicle, and fastest or safest.
- **On the other phone:** the same route opens. If that town isn't on the phone yet, it opens from saved towns or is downloaded automatically.

## Reports from people and official alerts

This is how the app learns about things nobody can predict: an accident an hour ago, a bandh today, a flooded underpass. TomTom live data helps, but it often doesn't cover small towns, so the people using the app and the local authorities fill the gap.

**Reporting (anyone)**
- Tap the spot on the map and choose **⚠ Report a problem here**, then pick the problem:

  | Problem | Effect on that road | Expires after |
  | --- | --- | --- |
  | Accident | heavy traffic, unsafe | 2 h |
  | Road closed | closed | 12 h |
  | Bandh / strike | closed | end of the day |
  | Flooding / waterlogging | heavy traffic, unsafe | 6 h |
  | Traffic jam | heavy traffic | 1 h |
  | Road works | moderate traffic, unsafe | 7 days |
  | Other problem | moderate traffic | 2 h |

- Or use **Report at my location** (or the buttons in Trip mode) to report where you are, by GPS.
- Reports show on the map and in the *Reports from people* list. Routes avoid them straight away: a closed or bandh road is not used, and an accident or flooding also counts as a hazard for the Safest route.
- Others answer **✓ Still there** or **✗ Cleared now** (one answer per device). When two people say *Cleared* and fewer say *Still there*, the report stops counting. Every report also expires by itself.

**Official alerts (police, municipality, project team)**
- Open **admin.html** (linked at the bottom of the page) and sign in with an admin account.
- Choose the kind (bandh, road closure, VIP movement, event / procession), a title, a message, and the start and end time. Then click the affected roads on the map; clicking a named road selects the whole road.
- Everyone sees the alert as a banner. Closures and bandhs close the chosen roads; the other kinds make them heavy.
- Admins can also remove false or abusive public reports.

**Tested end to end** with a fake Firebase:
- an admin posted a closure of Lower Tank Bund Road;
- a user's page showed the banner within a minute;
- a trip that normally takes 4.8 min along that road was re-routed via 100 feet Ring Road (11.9 min).

**Setting up the shared database (free, about 10 minutes).** Reports and alerts are shared through Google Firebase (Cloud Firestore).
1. Follow the steps at the top of `js/firebase-config.js` to create the project, the database and the admin accounts.
2. Paste the contents of `firestore.rules` into the Firebase console.
3. Copy the `apiKey` and `projectId` into `js/firebase-config.js`.

The web `apiKey` isn't secret; the rules protect the data:
- anyone can add a well-formed report and answer *Still there* or *Cleared*;
- only admins can post alerts or remove reports;
- speeds are short-lived and anonymous.

**Until Firebase is set up,** reports are saved only on the device that made them, and the page says so.

**Abuse and mistakes.** A false report affects routes for at most its expiry time, and others can clear it. Admins can delete reports. The rules limit what a report can contain and allow reports only inside India.

## Live traffic and incidents (TomTom)

The time-of-day estimate cannot know about *today*: an accident, a bandh, a broken-down lorry, road works or waterlogging. To react to the real situation, the app uses live data from TomTom, with your own free key.

**Set up (once per device)**
1. Sign up at <https://developer.tomtom.com/> and create an API key. The free plan includes the Traffic APIs.
2. In the app, open *Traffic conditions → TomTom API key*, paste the key and press **Save**.
3. Live traffic and incidents switch on and then **update automatically** while the page is open.

**What it detects**

| Live data | How it is used | Updated |
| --- | --- | --- |
| **Incidents**: accidents, road closures, road works, lane closures, flooding, broken-down vehicles, jams | Placed on the exact road sections they affect. A closure (or an "indefinite" delay) **closes** the road; others make it **moderate or heavy** by their reported delay. Accidents, closures, works, flooding and breakdowns also add a temporary **Live incident** hazard (+3 risk points per km), so the **Safest** route avoids them too. | Every **2 minutes** (1 request) |
| **Speeds** on main roads | Current ÷ free-flow speed at up to 80 points: 0.8 or more is light, 0.5 or more is moderate, below that heavy. This catches slowdowns even before anyone reports an incident. | Every **15 minutes** (up to 80 requests) |

When something changes, the routes are recalculated and the notice above the map says why. For example: *"Live update: 1 incident in the area. Recommendation changed: the route via Railway Station Road is now fastest…"*.

Other places it shows up:
- The *Traffic conditions* panel lists the current incidents. Tap one to see it on the map.
- Route cards warn when a route passes an incident.
- When TomTom reports the incident cleared, the next update puts the road back.

**Your own changes stay on top.** If you mark a road closed by hand (for example a procession you can see), later live updates do not undo it. Choosing a new time of day starts again.

**Request budget.** About 30 incident requests and 320 speed requests per hour of use. That's roughly 7 hours a day inside TomTom's free 2,500 requests a day. Updates pause while the page is hidden. The intervals are `incidentsEveryMs` and `speedsEveryMs` in `js/live-traffic.js`.

**Your key stays private.** It is stored only in that browser on that device (`localStorage`). It is never written into the project files or sent anywhere except TomTom. *Remove saved key* deletes it. Because the page runs in the browser, anyone using your device can read the key in the developer tools. TomTom lets you restrict a key to your website's address in its dashboard.

**Limits.**
- TomTom only knows what its data sources report. In a town the size of Vizianagaram, small lanes and very recent events may be missing. A bandh with no traffic data behind it won't appear.
- That is why the app also uses **reports from people** and **official alerts** (above).

## Vehicle types

| Vehicle | Speed | Traffic delay | Other rules |
| --- | --- | --- | --- |
| Car | Road's free-flow speed | Full | Follows one-way streets |
| Two-wheeler | Same, at most 50 km/h | 60% of a car's (filters through jams) | Follows one-way streets |
| Auto | At most 35 km/h | 85% of a car's | Follows one-way streets |
| Walking | Always 4.5 km/h | None | May use one-way streets both ways; no expressways |

## Language

The interface is available in English and Telugu (`js/i18n.js`).

**Place and road names in Telugu.**
- In Telugu mode, every place and road name is shown in Telugu script.
- Where OpenStreetMap has a Telugu name, it is used; it rarely does (6 of 280 places in Vizianagaram).
- Every other name is written in Telugu automatically by `js/translit.js`. It knows the exact spelling of local names and common words (Thotapalem → తోటపాలెం, Road → రోడ్డు, Hospital → ఆసుపత్రి, Nagar → నగర్, Junction → జంక్షన్). Other words are written by sound, and abbreviations are read letter by letter (R T C → ఆర్ టి సి).
- Automatic writing can't know long vowels that English spelling hides, so a few names come out close but not perfect. Add correct spellings to `NAMES` or `WORDS` in `js/translit.js`.
- **Search works in both scripts:** typing *తోటపాలెం*, *ఆసుపత్రి* or *thota* all find the place. Results show the English name too.

**The Telugu text was written for this project and should be checked by a native speaker before wider use.** To fix a translation, edit the `te` section of `js/i18n.js`. `npm test` checks that every English text has a Telugu version with the same `{placeholders}`.

## Demo town

### Two-minute demo script (demo town)

1. Open the demo with **Open the demo town** at the bottom of the page (or a link ending in `#mode=demo`). **← Back to the real map** returns. Start is **Bus Station**, destination **Engineering College**. Press **Find Best Route**. Route 1 *via MG Road* is recommended at 13.3 min; Route 2 *via Ring Road* is 1.2 min slower. Point out that MG Road is rated **Higher risk** because of the accident black spot on MG Road (west).
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

1. The user chooses **Fastest**, **Shortest**, **Safest** or **Greenest** and a vehicle. Each objective has its own edge weight, and all weights are positive, so Dijkstra's algorithm is exact:

   | Objective | Edge weight (what is minimised) | Unit (real map) | Ties broken by |
   | --- | --- | --- | --- |
   | Fastest | estimated travel time for that vehicle | seconds | shorter distance |
   | Shortest | length of the road section | metres | quicker time |
   | Safest | risk score = length × risk points per km | metre-points | quicker time |
   | Greenest | estimated fuel = length ÷ mileage + idling fuel × traffic delay (car 15 km/l and 0.8 l/h, auto 25 and 0.5, two-wheeler 45 and 0.25); CO₂ = 2.31 kg per litre | microlitres | quicker time |

   Walking uses no fuel, so the greenest walk is the quickest walk. The fuel model is a planning estimate (typical Indian figures), the same one the trip analytics use.
2. **Dijkstra's algorithm** (with a binary-heap priority queue) finds the best route for that weight. Ties on time go to the shorter distance; ties on risk go to the quicker route; then to location id, so results are fully deterministic.
3. **Alternatives.**
   - **Demo town:** **Yen's k-shortest-paths algorithm** (k = 8) lists the next-best loop-free routes by re-running Dijkstra with parts of earlier routes blocked.
   - **Real map:** the network is too big for Yen's algorithm, which also only finds tiny one-street detours there. The app uses the **penalty method** instead, as many navigation apps do: after each route is found, its roads are made 1.4 times more expensive and Dijkstra runs again (6 rounds). This pushes each search onto genuinely different roads, and each search takes about 0.1–0.2 s.
4. **Distinctness filter.** An alternative is shown only if at most 75% of its length is shared with every route already shown. If that leaves only one route, the next-best is added anyway. At most three routes are shown.
5. The best route under **each other objective** is always included, so the fastest, shortest, safest and greenest routes can be compared side by side (*Fastest*, *Shortest*, *Safest* and *Greenest* badges). Up to 3 routes are shown normally, 4 when all four objectives pick different routes. If one route is best at several things it carries several badges.
6. The **recommendation** is always the true optimum from step 2 for the chosen objective. Time, distance and risk are never mixed into a combined score, so the recommendation stays easy to explain.
7. **Why this route.** Every route card says in one line why it is shown: which objective it is best at (or that it is an alternative on different roads), how much of it is in heavy traffic, how many marked hazards it has, which closed roads were avoided, and where the traffic figures came from.

**Traffic data labels.** The *Traffic conditions* heading always shows where traffic comes from:

| Label | Meaning |
| --- | --- |
| Live | TomTom data fetched in the last 30 minutes (with the time of the last update) |
| Stale live data | Live is on, but the newest data is over 30 minutes old (for example after the phone slept); press *Refresh* |
| Estimated | No live data: a time-of-day estimate by road type. Never called live. |
| Demo (simulated) | The demo town's sample values |

Reports from people, official alerts and shared speeds are added on top of any of these, and are shown as such on the map and in the route explanation.

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

## Safety, privacy and security

- **Planning aid only.** The app is not an emergency service and does not guarantee road safety. The risk score is a heuristic from map tags and reports, not an official accident probability. No official black-spot list is included until you add real entries to `js/blackspots.js`.
- **GPS.** Browsers only give the location on `https://` pages (GitHub Pages is fine) and only after the user allows it. The app asks once per action, runs at most one location watcher during a trip, and stops it when the trip ends. Positions less accurate than ±100 m are ignored for off-route checks, and the off-route tolerance is never smaller than the GPS's own accuracy, so a weak signal does not cause false re-routing.
- **TomTom key.** It is stored only in the user's browser (`localStorage`) and never committed. Because GitHub Pages is a static site, anything the browser uses can be seen by that user; there is no secret server. To protect a key, restrict it in the TomTom developer portal (allowed websites, Traffic API only) and watch its usage. A fully confidential key would need a small server or serverless proxy, which this project does not have.
- **Firebase.** The web `apiKey` in `js/firebase-config.js` is public by design; `firestore.rules` protects the data: anyone may add a well-formed report inside India and add +1 to *Still there* / *Cleared*; only admins (listed in the `admins` collection) may post alerts or delete reports.
- **Reports.** One new report a minute per device; the same problem on the same road is counted as a confirmation instead of a second report; each report shows when it was made, whether anyone confirmed it, and when it expires. Notes are limited to 140 characters and always shown as plain text.
- **Untrusted text.** Place names in share links, report notes, TomTom descriptions and OpenStreetMap names are always escaped before display (including map tooltips), and share-link coordinates are range-checked.
- **Time limits.** TomTom requests give up after 20 s and Firebase requests after 15 s with a clear message, so nothing stays "loading" for ever.
- **Offline.** When the phone is offline a banner says so: saved towns and routing still work; live traffic, reports, alerts, new towns and unseen map pictures need the internet. Live services are never cached by the service worker.

## Known limitations

- **Live data needs your own key and depends on TomTom's coverage.** Without a key, traffic is estimated from time of day and road type and nothing that happens today is detected. With a key, accidents, closures, works and jams that TomTom knows about are detected automatically, and main roads get live speeds. Small lanes and events nobody has reported may still be missed.
- **Simplified journey times.** They ignore signal waits, turns and vehicle type. Traffic is constant along each road section.
- **Map data gaps.** OpenStreetMap data for smaller towns can miss lanes, have wrong one-way tags, or name places inconsistently. Only the largest connected part of the network is used, so every route found is drivable on the map data.
- **Inferred hazards.** Apart from your black spot list, hazards are worked out from the map, not from accident records.
- **No hospital capabilities.** Emergency mode plans a route only. It does not know which hospitals have a 24-hour casualty department, and it does not call for help. The helpline numbers shown (108 ambulance, 112 emergency) are for India.
- **Area limits.** The real map covers the box above. Points more than 400 m from any road in it are refused.

## Tests

```
npm run check         # syntax of every JS file; page ids and file references are consistent
npm test              # 103 automated tests (Node's built-in test runner, no dependencies)
npm run build         # builds the single-file version
npm run verify        # all three
```

**Demo town.** For every start–destination pair under every scenario and every hour, for both Fastest and Safest (5,544 queries), the recommendation is compared against a brute-force search of every possible path. The tests check badges, valid paths, no closed roads, no duplicates, and that every total and difference adds up exactly. Emergency is checked against brute force from every place.

**Vehicles.** For every pair of places and every vehicle type, the recommendation is checked against brute force.

**Live traffic and incidents** (with a fake TomTom server, no key needed). The tests check:
- speed sample points and speed-to-level rules;
- incident categories and delays turned into levels;
- incidents placed on the right road sections (and not on side lanes);
- a closure or accident on today's route changes the fastest and the safest recommendation;
- one request fetches all incidents for the area;
- error handling: wrong key, daily limit, no answer, a browser that throws.

**Objectives** (`tests/objectives.test.js`).
- For every pair in the demo town under every scenario and several hours, for Fastest, Shortest and Safest: the recommendation equals the brute-force optimum, each objective's best route is shown and badged exactly once, and no two routes shown are the same.
- On the real map (Thotapalem → Vizianagaram Junction, 9 AM): the shortest route is not longer than the others, the fastest not slower, the safest not riskier.
- GPS: positions worse than ±100 m never trigger re-routing; the off-route tolerance grows with the GPS accuracy.
- Time limits: a TomTom or Firebase server that never answers gives a "timeout" error; a TomTom reply that is not JSON gives "no answer". These use fake servers and prove the error handling, not the real services.

**Areas** (`tests/areas.test.js`, using the downloaded data in `data/osm/`, no internet).
- A whole city (Visakhapatnam's real outline) is cropped to its centre and flagged; a town outline is used whole.
- The bug-report trip (Pothinamallayyapalem → Hanumanthuwaka) did not fit in the 8 km square around the start, but fits in one trip area under the size limit; Vizianagaram → Visakhapatnam is refused.
- Only the newest area load counts.
- Two areas built from the same OpenStreetMap data give the same ids to different roads (over 100 clashes); reports and alerts are moved to the right road by position, legacy alerts stay on the built-in map, far-away alerts are ignored, and a moved closure really closes the road.
- A second area routes on its own graph and does not change the built-in map.

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
js/real-network-data.js        Built-in map: GENERATED by npm run build-map, stored packed (605 KB, unpacked on load in ~10 ms)
js/blackspots.js               Accident black spots for the real map (edit this)
js/route-engine.js             Algorithm: Dijkstra, Yen's k-shortest paths, penalty method, fastest/shortest/safest, vehicles, emergency
js/live-traffic.js             Live traffic and incidents from TomTom (optional, your own key)
js/osm-network.js              Builds a road network from OpenStreetMap data (used by the build script and the browser)
js/area-loader.js              Finds and downloads any town in the browser; keeps areas on the device
js/long-route.js               Long-distance routes from TomTom Routing or OpenStreetMap routing
js/analytics.js                Trip analytics: baseline, hourly times, reliability, fuel/CO2, CSV
js/accounts.js                 Optional user accounts (Firebase Authentication) and synced saved places
js/translit.js                 English -> Telugu writing of place and road names
js/directions.js               Turn-by-turn directions
js/community.js                Community reports, official alerts, shared trip speeds (Firebase or this device only)
js/trip.js                     Trip mode logic: position on the route, next step, off-route, measured speeds
js/admin.js, admin.html        Admin page for official alerts and report moderation
sw.js, manifest.webmanifest    Install as an app and offline use
icons/                         App icons (drawn by scripts/make-icons.js)
js/firebase-config.js          Your Firebase settings (empty = reports stay on this device)
firestore.rules                Security rules to paste into Firebase
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
tests/community.test.js        Reports, alerts, speeds (fake Firebase server)
tests/directions.test.js       Turn-by-turn directions
tests/trip.test.js             Trip mode with simulated GPS
tests/translit.test.js         English -> Telugu names
tests/area-loader.test.js      Loading other towns (fake servers)
tests/i18n.test.js             English / Telugu text checks
tests/objectives.test.js       Fastest / shortest / safest, GPS accuracy, time-outs
tests/areas.test.js            Area sizes, trips across a city, newest load wins, no mixing of areas
tests/analytics.test.js        Time saved, hourly times, reliability, fuel model, accounts (fake Firebase), admin aggregates
tests/long-route.test.js       Long-distance routes and place search (real saved answers + mocked TomTom)
tests/fixtures/                Real answers saved from OpenStreetMap routing and Photon
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
