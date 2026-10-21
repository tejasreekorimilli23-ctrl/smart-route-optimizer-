/*
 * Browser smoke test: opens index.html in headless Chromium and drives the
 * demo the way a presenter would. Optional; needs Playwright:
 *     npm install --no-save playwright && npx playwright install chromium
 *     npm run test:browser
 * Screenshots are written to tests/screenshots/.
 */
"use strict";
/* global window, document, Event -- used inside page.evaluate() / $eval(), which run in the browser */

const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright is not installed. Run: npm install --no-save playwright && npx playwright install chromium");
  process.exit(2);
}

const PAGE = "file://" + path.resolve(__dirname, "..", "index.html");
const DEMO = PAGE + "#mode=demo&lang=en";
const REAL = PAGE + "#mode=real&lang=en";
const SHOTS = path.resolve(__dirname, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

/** Playwright cannot fill() a range input, so set it and fire "input" like a drag would. */
async function setSlider(page, selector, value) {
  await page.$eval(selector, (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(["PASS", name]);
  } catch (err) {
    results.push(["FAIL", name + " :: " + err.message]);
  }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(e.message));
  page.on("console", (m) => {
    // The web-font request may fail offline; the page falls back to system fonts.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) jsErrors.push(m.text());
  });

  await page.goto(DEMO);

  await step("page renders with no JavaScript errors", async () => {
    await page.waitForSelector("#map-layer circle");
    assert.equal(await page.locator("#app-error").isHidden(), true);
    assert.equal(await page.locator("#origin option").count(), 13);
    assert.match(await page.textContent("#results-body"), /No routes yet/);
  });

  await step("Find Best Route shows 3 routes with MG Road recommended", async () => {
    await page.click("button:has-text('Find Best Route')");
    await page.waitForSelector(".route-card");
    assert.equal(await page.locator(".route-card").count(), 3);
    assert.match(await page.textContent(".route-card.is-recommended"), /via MG Road/);
    assert.match(await page.textContent("#map-summary"), /13\.3 min for 7\.3 km/);
    await page.screenshot({ path: path.join(SHOTS, "desktop-offpeak.png") });
  });

  await step("on-screen numbers match the engine output", async () => {
    const check = await page.evaluate(() => {
      const levels = window.RouteEngine.levelsForScenario(window.TrafficData, "offpeak");
      const res = window.RouteEngine.findRoutes(window.TrafficData, levels, "BUS", "COL");
      const cards = Array.from(document.querySelectorAll(".route-card"));
      return res.routes.map((r, i) => {
        const nums = cards[i].querySelectorAll(".metric .num");
        const stops = Array.from(cards[i].querySelectorAll(".stops li")).map((li) => li.textContent);
        return {
          expect: [(r.timeUnits / 10).toFixed(1), (r.distanceUnits / 10).toFixed(1), r.nodeNames.join("|")],
          shown: [nums[0].textContent, nums[1].textContent, stops.join("|")],
          cmp: cards[i].querySelector(".cmp").textContent,
          extra: (r.extraTimeUnits / 10).toFixed(1)
        };
      });
    });
    check.forEach((c, i) => {
      assert.deepEqual(c.shown, c.expect, "route " + (i + 1));
      if (i > 0) assert.ok(c.cmp.startsWith(c.extra + " min slower"), c.cmp);
    });
  });

  await step("calculation table rows add up to the route total", async () => {
    await page.click("#calc summary");
    const ok = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".calc-table tbody tr"));
      const sum = rows.reduce((s, tr) => s + Math.round(parseFloat(tr.lastElementChild.textContent) * 10), 0);
      const total = Math.round(parseFloat(document.querySelector(".calc-table tfoot tr").lastElementChild.textContent) * 10);
      return { sum, total };
    });
    assert.equal(ok.sum, ok.total);
  });

  await step("Morning rush changes the recommendation and explains why", async () => {
    await page.click("label.tile:has-text('Morning rush')");
    assert.match(await page.textContent("#change-notice"), /Recommendation changed.*via Ring Road.*14\.5 min.*28\.8 min/);
    assert.match(await page.textContent(".route-card.is-recommended"), /via Ring Road/);
    await page.screenshot({ path: path.join(SHOTS, "desktop-rush.png") });
  });

  await step("map focus follows a changed recommendation, but keeps a user-chosen alternative", async () => {
    await page.click("label.tile:has-text('Off-peak')");
    await page.click("label.tile:has-text('Market day')"); // MG Road route drops to Route 2
    const rec = page.locator(".route-card.is-recommended .map-toggle");
    assert.equal(await rec.getAttribute("aria-pressed"), "true", "map should show the new recommendation");
    await page.locator(".route-card").nth(2).locator(".map-toggle").click(); // user picks Route 3
    const sig = await page.locator(".route-card").nth(2).locator(".map-toggle").getAttribute("data-sig");
    await page.click("label.tile:has-text('Off-peak')");
    assert.equal(await page.locator(`.map-toggle[data-sig="${sig}"]`).getAttribute("aria-pressed"), "true", "user's choice kept");
  });

  await step("clicking a road on the map selects it, and editing it recalculates", async () => {
    await page.click("label.tile:has-text('Off-peak')");
    await page.click('[data-edge="e08"] .road-hit', { force: true });
    assert.equal(await page.inputValue("#road-select"), "e08");
    await page.click("label.seg:has-text('Heavy')");
    assert.match(await page.textContent("#change-notice"), /MG Road \(east\) set to heavy traffic\. Recommendation changed/);
    assert.match(await page.textContent("#scenario-desc"), /Custom conditions/);
    await page.click("label.seg:has-text('Light')");
    assert.match(await page.textContent(".route-card.is-recommended"), /via MG Road/);
  });

  await step("Show on map switches the focused route and breakdown", async () => {
    const btn = page.locator(".route-card").nth(1).locator(".map-toggle");
    await btn.click();
    assert.equal(await page.locator(".route-card").nth(1).locator(".map-toggle").getAttribute("aria-pressed"), "true");
    assert.match(await page.textContent("#calc-body"), /Breakdown for Route 2/);
  });

  await step("same start and destination shows a clear error", async () => {
    await page.selectOption("#destination", "BUS");
    assert.match(await page.textContent("#map-summary"), /Out of date/);
    await page.click("button:has-text('Find Best Route')");
    assert.match(await page.textContent("#form-error"), /same place/);
    assert.equal(await page.getAttribute("#destination", "aria-invalid"), "true");
  });

  await step("missing selection shows a clear error", async () => {
    await page.selectOption("#origin", "");
    await page.click("button:has-text('Find Best Route')");
    assert.match(await page.textContent("#form-error"), /Choose a starting point/);
  });

  await step("unreachable destination shows guidance and can recover", async () => {
    await page.selectOption("#origin", "BUS");
    await page.selectOption("#destination", "LKV");
    await page.click("label.tile:has-text('Road works')");
    await page.click("button:has-text('Find Best Route')");
    assert.match(await page.textContent(".error-state"), /No open road connects Bus Station to Lake View Colony/);
    assert.match(await page.textContent(".error-state"), /Lake Bridge/);
    await page.screenshot({ path: path.join(SHOTS, "desktop-unreachable.png") });
    await page.click("button:has-text('Reopen closed roads')");
    assert.ok((await page.locator(".route-card").count()) >= 1);
  });

  await step("only-one-route case is explained", async () => {
    await page.selectOption("#origin", "STD");
    await page.click("button:has-text('Find Best Route')");
    assert.equal(await page.locator(".route-card").count(), 1);
    assert.match(await page.textContent("#results-body"), /Only one route connects/);
  });

  await step("Safest route avoids the black spot and both badges are shown", async () => {
    await page.click("#reset");
    await page.click("button:has-text('Find Best Route')");
    await page.click("label.tile:has-text('Safest route')");
    assert.match(await page.textContent(".route-card.is-recommended"), /via Ring Road/);
    assert.match(await page.textContent(".route-card.is-recommended"), /Safer route/);
    assert.match(await page.textContent("#change-notice"), /Now recommending the safest route/);
    assert.match(await page.textContent(".results-summary"), /The fastest route, Route \d via MG Road, would save 1\.2 min/);
    assert.equal(await page.locator(".tag-badge:has-text('Fastest')").count(), 1);
    assert.equal(await page.locator(".tag-badge:has-text('Safest')").count(), 1);
    assert.match(await page.textContent("#results-body"), /Accident black spot on MG Road \(west\)/);
    await page.screenshot({ path: path.join(SHOTS, "desktop-safest.png") });
    await page.click("label.tile:has-text('Fastest route')");
    assert.match(await page.textContent(".route-card.is-recommended"), /via MG Road/);
  });

  await step("time-of-day slider changes traffic and the recommendation", async () => {
    assert.match(await page.textContent("#hour-label"), /12:00 PM · Midday/);
    await setSlider(page, "#hour", 18);
    assert.match(await page.textContent("#hour-label"), /6:00 PM · Evening rush/);
    assert.match(await page.textContent("#change-notice"), /6:00 PM traffic \(evening rush\) applied\. Recommendation changed.*via Ring Road/);
    await setSlider(page, "#hour", 9);
    assert.equal(await page.isChecked("input[name=scenario][value=rush]"), true, "9 AM matches the Morning rush preset");
    await page.click("label.tile:has-text('Market day')");
    assert.match(await page.textContent("#hour-label"), /Not in use/);
  });

  await step("Emergency routes to the hospital, and explains edge cases", async () => {
    await page.click("label.tile:has-text('Off-peak')");
    await page.selectOption("#origin", "RLY");
    await page.click("#emergency");
    assert.equal(await page.inputValue("#destination"), "HSP");
    assert.match(await page.textContent(".emergency-banner"), /Emergency route to Government Hospital/);
    assert.match(await page.textContent(".emergency-banner"), /108/);
    assert.match(await page.textContent("#map-summary"), /Emergency/);
    await page.screenshot({ path: path.join(SHOTS, "desktop-emergency.png") });
    await page.selectOption("#origin", "HSP");
    await page.click("#emergency");
    assert.match(await page.textContent("#form-error"), /already at Government Hospital/);
  });

  await step("keyboard: Tab from the priority choice reaches Find Best Route, Enter runs it", async () => {
    await page.selectOption("#origin", "RLY");
    await page.selectOption("#destination", "COL");
    await page.focus("input[name=priority]:checked");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), "Find Best Route");
    await page.keyboard.press("Enter");
    assert.match(await page.textContent(".results-summary"), /Railway Station/);
  });

  await step("Reset demo restores the starting state", async () => {
    await page.click("#reset");
    assert.match(await page.textContent("#results-body"), /No routes yet/);
    assert.equal(await page.inputValue("#origin"), "BUS");
    assert.equal(await page.isChecked("input[name=scenario][value=offpeak]"), true);
    assert.equal(await page.inputValue("#hour"), "12");
    assert.equal(await page.isChecked("input[name=priority][value=fastest]"), true);
  });

  await step("mobile layout: no sideways page scroll, map and cards usable", async () => {
    const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    m.on("pageerror", (e) => jsErrors.push("mobile: " + e.message));
    await m.goto(DEMO);
    await m.click("button:has-text('Find Best Route')");
    await m.click("label.tile:has-text('Morning rush')");
    const widths = await m.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    assert.ok(widths.doc <= widths.win, `page is ${widths.doc}px wide in a ${widths.win}px viewport`);
    assert.equal(await m.locator(".route-card").count(), 3);
    await m.screenshot({ path: path.join(SHOTS, "mobile-rush.png"), fullPage: true });
    await m.close();
  });

  await step("real map: Thotapalem to Vizianagaram Junction on real roads", async () => {
    const r = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    r.on("pageerror", (e) => jsErrors.push("real: " + e.message));
    await r.goto(REAL);
    await r.waitForSelector("#real-map .leaflet-container, #real-map.leaflet-container");
    assert.equal(await r.$eval("#origin", (s) => s.selectedOptions[0].text), "Thotapalem");
    await r.click("button:has-text('Find Best Route')");
    await r.waitForSelector(".route-card");
    assert.match(await r.textContent(".results-summary"), /From Thotapalem to Vizianagaram Junction/);
    assert.ok((await r.locator(".route-card").count()) >= 2);
    await r.screenshot({ path: path.join(SHOTS, "real-map.png") });

    // Map click: set a destination by pinning a point to the nearest road.
    await r.evaluate(() => window.RealMapView.onAction("set-destination", { lat: 18.1146, lng: 83.4128 }));
    assert.match(await r.$eval("#destination", (s) => s.selectedOptions[0].text), /^Point on /);
    assert.match(await r.textContent("#map-summary"), /Recommended/);

    // Search box: type part of a name and pick a suggestion with the keyboard.
    await r.fill("#destination-search", "maharaja dist");
    await r.waitForSelector("#destination-list:not([hidden]) .ps-option");
    await r.keyboard.press("Enter");
    assert.match(await r.$eval("#destination", (s) => s.selectedOptions[0].text), /Maharaja District Hospital/);

    // Vehicle type: walking takes much longer than a two-wheeler.
    await r.click("button:has-text('Find Best Route')");
    await r.click("label.tile:has-text('Two-wheeler')");
    const bike = parseFloat(await r.textContent(".route-card.is-recommended .metric-time .num"));
    await r.click("label.tile:has-text('Walking')");
    const walk = parseFloat(await r.textContent(".route-card.is-recommended .metric-time .num"));
    assert.ok(walk > bike * 2, `walking ${walk} min vs two-wheeler ${bike} min`);
    await r.click("label.tile:has-text('Car')");

    // Telugu interface.
    await r.click("label.mode:has-text('తెలుగు')");
    assert.match(await r.textContent("#planner-title"), /మార్గం/);
    assert.match(await r.textContent("#map-summary"), /సిఫార్సు/);
    await r.click("label.mode:has-text('English')");

    // Emergency from Thotapalem lists nearby hospitals.
    await r.fill("#origin-search", "thotapalem");
    await r.waitForSelector("#origin-list:not([hidden]) .ps-option");
    await r.keyboard.press("Enter");
    await r.click("#emergency");
    assert.match(await r.textContent(".emergency-banner"), /Emergency route to/);
    assert.match(await r.textContent(".emergency-banner"), /Other hospitals nearby/);

    // A point outside the mapped area is refused with an explanation.
    await r.evaluate(() => window.RealMapView.onAction("set-start", { lat: 18.3, lng: 83.6 }));
    assert.match(await r.textContent("#form-error"), /only covers this area/);

    // Switching to the demo town and back works.
    await r.click("#demo-open");
    assert.match(await r.textContent("#mode-badge-text"), /Demo mode/);
    await r.click("#demo-exit");
    assert.match(await r.textContent("#mode-badge-text"), /Real roads/);
    await r.close();
  });

  await step("no JavaScript errors during the whole run", async () => {
    assert.deepEqual(jsErrors, []);
  });

  await browser.close();
  for (const [status, name] of results) console.log(status + "  " + name);
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} browser checks passed`);
  process.exit(failed ? 1 : 0);
})();
