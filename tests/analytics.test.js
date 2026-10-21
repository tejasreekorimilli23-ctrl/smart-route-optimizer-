/*
 * Trip analytics, user accounts, admin aggregates and long-route options.
 * Run with: npm test
 *
 * The account tests use a FAKE Firebase (in memory) shaped like Firebase's
 * REST answers: they test the app's logic, not Google's servers.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../js/route-engine.js");
const R = require("../js/real-network-data.js");
const D = require("../js/network-data.js");
const TA = require("../js/analytics.js");
const ACC = require("../js/accounts.js");
const CM = require("../js/community.js");
const LR = require("../js/long-route.js");

test("time saved is measured against the route a traffic-unaware planner would pick", () => {
  // Demo town at the morning rush: the free-flow favourite (MG Road) is jammed.
  const levels = E.levelsForScenario(D, "rush");
  const res = E.findRoutes(D, levels, "BUS", "COL", {});
  const b = TA.baseline(E, D, levels, "BUS", "COL", "car", res.recommended);
  const free = E.findRoutes(D, TA.freeLevels(D), "BUS", "COL", {}).recommended;
  assert.equal(b.route.signature, free.signature, "the baseline is the free-flow favourite");
  assert.equal(b.nowTimeUnits, E.evaluatePath(D, levels, free.edges).timeUnits, "timed under today's traffic");
  assert.equal(b.savedUnits, b.nowTimeUnits - res.recommended.timeUnits);
  assert.ok(b.savedUnits > 0, "using traffic information saves time here");
  // Off-peak: both choose the same route, nothing saved.
  const off = E.levelsForScenario(D, "offpeak");
  const r2 = E.findRoutes(D, off, "BUS", "COL", {});
  const b2 = TA.baseline(E, D, off, "BUS", "COL", "car", r2.recommended);
  assert.equal(b2.same, true);
  assert.equal(b2.savedUnits, 0);
});

test("a baseline route over a closed road is reported as blocked", () => {
  const levels = E.levelsForScenario(D, "offpeak");
  const free = E.findRoutes(D, TA.freeLevels(D), "BUS", "COL", {}).recommended;
  const closed = Object.assign({}, levels, { [free.edges[0]]: "closed" });
  const res = E.findRoutes(D, closed, "BUS", "COL", {});
  const b = TA.baseline(E, D, closed, "BUS", "COL", "car", res.recommended);
  assert.equal(b.blocked, true);
  assert.equal(b.savedUnits, null);
});

test("travel time by departure hour comes from the estimates, one value per hour", () => {
  const h = TA.byHour(E, R, R.DEFAULTS.origin, R.DEFAULTS.destination, "car");
  assert.equal(h.length, R.DAY_END_HOUR - R.DAY_START_HOUR + 1);
  for (const x of h) {
    const res = E.findRoutes(R, E.levelsForHour(R, x.hour), R.DEFAULTS.origin, R.DEFAULTS.destination, {});
    assert.equal(x.timeUnits, res.recommended.timeUnits, "hour " + x.hour);
  }
  const rush = h.find((x) => x.hour === 9).timeUnits;
  const night = h.find((x) => x.hour === 21).timeUnits;
  assert.ok(rush > night, "rush hour is slower than night");
});

test("reliability: spread of times, from recorded trips when there are 3 or more", () => {
  const hourly = [{ hour: 6, timeUnits: 100 }, { hour: 9, timeUnits: 250 }];
  assert.equal(TA.reliability(hourly, []).key, "low");
  assert.equal(TA.reliability(hourly, []).source, "estimates");
  const r = TA.reliability(hourly, [100, 105, 110]);
  assert.equal(r.source, "trips");
  assert.equal(r.key, "high");
  assert.equal(r.spreadPct, 10);
  assert.equal(TA.median([5, 1, 3]), 3);
  assert.equal(TA.median([4, 1, 3, 2]), 2.5);
});

test("fuel and CO2 model follows its documented formula", () => {
  const e = TA.eco(15, 0.5, "car"); // 15 km at 15 km/l + 0.5 h idling at 0.8 l/h
  assert.equal(e.litres, 1.4);
  assert.equal(e.co2Kg, Math.round(1.4 * 2.31 * 100) / 100);
  assert.deepEqual(TA.eco(5, 1, "walk"), { litres: 0, co2Kg: 0 });
  assert.ok(TA.eco(10, 0, "twowheeler").litres < TA.eco(10, 0, "auto").litres);
});

test("congestion shares add up to 100%, and the CSV report is safe to open", () => {
  const d = TA.distribution({ light: 333, moderate: 333, heavy: 334 });
  assert.equal(d.light + d.moderate + d.heavy, 100);
  const csv = TA.toCsv([["Route", "km"], ['via "MG Road", east', "1.5"], ["తోటపాలెం", "2"]]);
  assert.ok(csv.startsWith("\uFEFF"), "byte-order mark so Excel shows Telugu");
  assert.match(csv, /"via ""MG Road"", east",1\.5/);
});

// ---------- accounts (FAKE Firebase) ----------

function fakeFirebase() {
  const users = {};
  const docs = {};
  const calls = [];
  let n = 0;
  const reply = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
  const fetchImpl = (url, opts = {}) => {
    calls.push({ url, opts });
    const body = opts.body && opts.headers && opts.headers["Content-Type"] === "application/json" ? JSON.parse(opts.body) : null;
    if (url.includes("accounts:signUp")) {
      if (users[body.email]) return reply(400, { error: { message: "EMAIL_EXISTS" } });
      if (body.password.length < 6) return reply(400, { error: { message: "WEAK_PASSWORD : Password should be at least 6 characters" } });
      const uid = "u" + ++n;
      users[body.email] = { uid, password: body.password };
      return reply(200, { localId: uid, email: body.email, idToken: "tok-" + uid, refreshToken: "ref-" + uid, expiresIn: "3600" });
    }
    if (url.includes("accounts:signInWithPassword")) {
      const u = users[body.email];
      if (!u || u.password !== body.password) return reply(400, { error: { message: "INVALID_LOGIN_CREDENTIALS" } });
      return reply(200, { localId: u.uid, email: body.email, idToken: "tok-" + u.uid, refreshToken: "ref-" + u.uid, expiresIn: "3600" });
    }
    if (url.includes("accounts:sendOobCode")) return reply(200, { email: body.email });
    const m = /documents\/users\/([^?]+)/.exec(url);
    if (m) {
      const uid = decodeURIComponent(m[1]);
      const auth = opts.headers && opts.headers.Authorization;
      if (auth !== "Bearer tok-" + uid) return reply(403, { error: { status: "PERMISSION_DENIED", message: "Missing or insufficient permissions." } });
      if (opts.method === "PATCH") { docs[uid] = body; return reply(200, body); }
      return docs[uid] ? reply(200, docs[uid]) : reply(404, { error: { status: "NOT_FOUND" } });
    }
    return reply(500, {});
  };
  return { fetchImpl, calls, docs };
}

function memoryStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
}

test("accounts are not offered without Firebase settings", () => {
  assert.equal(ACC.create(null, memoryStorage()), null);
  assert.equal(ACC.create({ apiKey: "", projectId: "p" }, memoryStorage()), null);
});

test("sign up, sign out, sign in again; data follows the account (fake Firebase)", async () => {
  const fb = fakeFirebase();
  const storage = memoryStorage();
  const acc = ACC.create({ apiKey: "k", projectId: "p" }, storage, fb.fetchImpl);
  await assert.rejects(acc.signUp("not-an-email", "secret1"), (e) => e.code === "email");
  await assert.rejects(acc.signUp("a@b.in", "123"), (e) => e.code === "weak");
  const me = await acc.signUp("teju@example.com", "secret12");
  assert.equal(me.email, "teju@example.com");
  assert.ok(JSON.parse(storage.getItem(ACC.SESSION_KEY)).refreshToken, "session kept in this browser");
  await assert.rejects(acc.signUp("teju@example.com", "secret12"), (e) => e.code === "exists");

  assert.deepEqual(await acc.load(), {}, "a new account has no data yet");
  const data = { places: [{ name: "Lendi Institute", lat: 18.02, lon: 83.4013 }], recent: [], trips: [] };
  await acc.store(data);

  acc.signOut();
  assert.equal(acc.current(), null);
  assert.equal(storage.getItem(ACC.SESSION_KEY), null);
  await assert.rejects(acc.load(), (e) => e.code === "signedout");
  await assert.rejects(acc.signIn("teju@example.com", "wrong-pass"), (e) => e.code === "wrong");

  // Another device: a fresh storage, the same account.
  const acc2 = ACC.create({ apiKey: "k", projectId: "p" }, memoryStorage(), fb.fetchImpl);
  await acc2.signIn("teju@example.com", "secret12");
  assert.deepEqual(await acc2.load(), data, "saved places come back on the other device");
  assert.equal(await acc2.resetPassword("teju@example.com"), true);
});

test("one user cannot read another user's data (fake Firebase enforcing the rule)", async () => {
  const fb = fakeFirebase();
  const a = ACC.create({ apiKey: "k", projectId: "p" }, memoryStorage(), fb.fetchImpl);
  await a.signUp("a@example.com", "secret12");
  await a.store({ places: [{ name: "Home", lat: 1, lon: 2 }] });
  const b = ACC.create({ apiKey: "k", projectId: "p" }, memoryStorage(), fb.fetchImpl);
  await b.signUp("b@example.com", "secret12");
  assert.deepEqual(await b.load(), {}, "b sees only b's own (empty) document");
  const docCalls = fb.calls.filter((c) => c.url.includes("documents/users/"));
  assert.ok(docCalls.every((c) => /Bearer tok-u\d/.test(c.opts.headers.Authorization)), "every data request carries the user's token");
});

// ---------- admin aggregates ----------

test("admin analytics are counts and medians only, never positions", () => {
  const now = new Date("2026-10-21T10:00:00");
  const later = new Date("2026-10-21T12:00:00");
  const reports = [
    { type: "accident", roadName: "MG Road", lat: 18.1, lon: 83.4, createdAt: new Date("2026-10-21T09:10:00"), expiresAt: later, confirms: 0, clears: 0 },
    { type: "jam", roadName: "MG Road", lat: 18.1, lon: 83.4, createdAt: new Date("2026-10-21T09:40:00"), expiresAt: later, confirms: 1, clears: 0 },
    { type: "jam", roadName: "Ring Road", lat: 18.2, lon: 83.5, createdAt: new Date("2026-10-21T08:00:00"), expiresAt: new Date("2026-10-21T09:00:00"), confirms: 0, clears: 0 }
  ];
  const speeds = [
    { edgeId: "T:e1", kmh: 10 }, { edgeId: "T:e1", kmh: 30 }, { edgeId: "T:e1", kmh: 20 }, { edgeId: "X:e9", kmh: 50 }
  ];
  const agg = CM.aggregate(reports, [], speeds, now, (id) => (id.startsWith("T:") ? "MG Road" : null));
  assert.equal(agg.reports.total, 2, "the expired report is not counted");
  assert.deepEqual(agg.reports.byType, { accident: 1, jam: 1 });
  assert.deepEqual(agg.reports.byRoad, [["MG Road", 2]]);
  assert.equal(agg.reports.byHour[9], 2);
  assert.deepEqual(agg.speeds.roads, [{ road: "MG Road", n: 3, medianKmh: 20 }]);
  assert.equal(agg.speeds.readings, 3, "readings from another area are left out");
  assert.ok(!JSON.stringify(agg).includes("18.1"), "no coordinates in the result");
});

// ---------- long routes: tolls and departure time ----------

test("TomTom long routes can avoid tolls and use a later departure time", () => {
  const from = { lat: 17.7231, lon: 83.3013 };
  const to = { lat: 18.02, lon: 83.4013 };
  const later = new Date(Date.now() + 3 * 3600000);
  const u = LR.tomtomUrl(from, to, "car", "KEY1234567890", { avoidTolls: true, departAt: later });
  assert.match(u, /avoid=tollRoads/);
  assert.match(decodeURIComponent(u), /departAt=\d{4}-\d\d-\d\dT\d\d:\d\d:00[+-]\d\d:\d\d/);
  const now = LR.tomtomUrl(from, to, "car", "KEY1234567890", { departAt: new Date() });
  assert.doesNotMatch(now, /departAt/, "leaving now: no departAt");
  assert.equal(LR.isoLocal(new Date(2026, 9, 22, 8, 30)).slice(0, 19), "2026-10-22T08:30:00");
});
