/*
 * Community reports, official alerts and shared trip speeds.
 * Uses a small fake of the Firestore and Firebase Auth REST APIs, so no
 * Firebase project or internet is needed. Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/real-network-data.js");
const E = require("../js/route-engine.js");
const C = require("../js/community.js");

const CONFIG = { apiKey: "test-api-key", projectId: "demo-project" };
const ADMIN = { email: "police@example.com", password: "test-password-123", uid: "uid-police" };

/** Minimal in-memory Firestore + Auth REST server. */
function fakeFirebase() {
  const db = { reports: {}, alerts: {}, speeds: {} };
  const tokens = {};
  let next = 1;
  const calls = [];
  const reply = (status, body) => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
  const base = "https://firestore.googleapis.com/v1/projects/demo-project/databases/(default)/documents";
  const valueOf = (v) => C.fromDoc({ name: "x/x", fields: { v } }).v;
  const fetchImpl = (url, opts = {}) => {
    calls.push({ url, method: opts.method, auth: opts.headers && opts.headers.Authorization });
    if (!url.includes("key=" + CONFIG.apiKey)) return reply(403, {});
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.startsWith("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword")) {
      if (body.email !== ADMIN.email || body.password !== ADMIN.password) return reply(400, { error: { message: "INVALID_PASSWORD" } });
      const tok = "tok-" + next++;
      tokens[tok] = ADMIN.uid;
      return reply(200, { idToken: tok, email: ADMIN.email, localId: ADMIN.uid });
    }
    const isAdmin = () => opts.headers && opts.headers.Authorization && tokens[opts.headers.Authorization.replace("Bearer ", "")] === ADMIN.uid;
    if (url.startsWith(base + ":runQuery")) {
      const q = body.structuredQuery;
      const col = q.from[0].collectionId;
      const f = q.where.fieldFilter;
      const after = valueOf(f.value);
      const rows = Object.values(db[col])
        .filter((d) => C.fromDoc(d)[f.field.fieldPath] > after)
        .map((d) => ({ document: d }));
      return reply(200, rows.length ? rows : [{ readTime: new Date().toISOString() }]);
    }
    if (url.startsWith(base + ":commit")) {
      for (const w of body.writes) {
        const doc = Object.values(db.reports).find((d) => d.name === w.transform.document);
        if (!doc) return reply(404, {});
        for (const ft of w.transform.fieldTransforms) {
          const cur = Number(doc.fields[ft.fieldPath].integerValue);
          doc.fields[ft.fieldPath] = { integerValue: String(cur + Number(ft.increment.integerValue)) };
        }
      }
      return reply(200, { writeResults: [] });
    }
    const m = /documents\/(reports|alerts|speeds)(?:\/([^?]+))?\?/.exec(url);
    if (m && opts.method === "POST") {
      if (m[1] === "alerts" && !isAdmin()) return reply(403, {});
      const id = "doc" + next++;
      const doc = { name: "projects/demo-project/databases/(default)/documents/" + m[1] + "/" + id, fields: body.fields };
      db[m[1]][id] = doc;
      return reply(200, doc);
    }
    if (m && opts.method === "DELETE") {
      if (!isAdmin()) return reply(403, {});
      delete db[m[1]][m[2]];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    return reply(404, {});
  };
  return { db, calls, fetchImpl };
}

const now = new Date("2026-10-21T13:00:00+05:30");
const roadEdge = () => R.EDGES.find((e) => e.corridor === "R T C Complex Road");

test("reports expire by type; a bandh lasts until the end of the day", () => {
  assert.equal(C.expiryFor("accident", now) - now, 120 * 60000);
  assert.equal(C.expiryFor("jam", now) - now, 60 * 60000);
  const bandh = C.expiryFor("bandh", now);
  assert.equal(bandh.getDate(), now.getDate());
  assert.equal(bandh.getHours(), 23);
  const r = C.newReport({ type: "accident", lat: 18.1, lon: 83.4, edgeId: "r1" }, now);
  assert.equal(C.isActive(r, now), true);
  assert.equal(C.isActive(r, new Date(now.getTime() + 121 * 60000)), false, "expired");
  assert.equal(C.isActive({ ...r, clears: 2, confirms: 1 }, now), false, "cleared by people");
  assert.equal(C.isActive({ ...r, clears: 2, confirms: 3 }, now), true, "more people say it is still there");
  assert.equal(C.validateReport({ type: "meteor", lat: 1, lon: 1 }), "type");
  assert.equal(C.validateReport({ type: "jam", lat: NaN, lon: 1 }), "place");
  assert.equal(C.validateReport({ type: "jam", lat: 18, lon: 83, note: "x".repeat(200) }), "note");
});

test("reported accidents and closures change the fastest and the safest route", () => {
  const levels = E.levelsForHour(R, 12);
  const before = E.findRoutes(R, levels, R.DEFAULTS.origin, R.DEFAULTS.destination);
  const named = before.recommended.edges.map((id) => R.EDGES.find((e) => e.id === id)).filter((e) => e.corridor);
  const target = named[Math.floor(named.length / 2)];
  const report = C.newReport({ type: "closed", lat: target.geom[0], lon: target.geom[1], edgeId: target.id }, now);
  const fx = C.effects([report], [], now);
  assert.equal(fx.levels[target.id], "closed");
  assert.ok(fx.unsafe.includes(target.id));
  const after = E.findRoutes(R, { ...levels, ...fx.levels }, R.DEFAULTS.origin, R.DEFAULTS.destination);
  for (const r of after.routes) assert.ok(!r.edges.includes(target.id), "a route still uses the reported closed road");
  // Once it expires, the road is back.
  assert.deepEqual(C.effects([report], [], new Date(now.getTime() + 13 * 3600000)).levels, {});
});

test("official alerts close their roads while they are on", () => {
  const e = roadEdge();
  const alert = { kind: "bandh", edges: [e.id], startsAt: new Date(now - 3600000), endsAt: new Date(now.getTime() + 3600000) };
  assert.equal(C.effects([], [alert], now).levels[e.id], "closed");
  assert.deepEqual(C.effects([], [alert], new Date(now.getTime() + 2 * 3600000)).levels, {}, "after it ends");
  assert.deepEqual(C.effects([], [{ ...alert, startsAt: new Date(now.getTime() + 600000) }], now).levels, {}, "before it starts");
  const vip = { kind: "vip", edges: [e.id], endsAt: new Date(now.getTime() + 3600000) };
  assert.equal(C.effects([], [vip], now).levels[e.id], "heavy");
});

test("shared trip speeds detect a jam nobody reported", () => {
  const e = roadEdge();
  const free = (edge) => E.buildGraph(R, null, "fastest", "car").edgeInfo[edge.id].freeFlowKmh;
  const fresh = new Date(now.getTime() + 10 * 60000);
  const one = [{ edgeId: e.id, kmh: 5, expiresAt: fresh }];
  assert.deepEqual(C.speedLevels(R, one, now, free).levels, {}, "one reading is not enough");
  const crawling = [5, 6, 30].map((kmh) => ({ edgeId: e.id, kmh, expiresAt: fresh }));
  assert.equal(C.speedLevels(R, crawling, now, free).levels[e.id], "heavy", "median 6 km/h on a 40 km/h main road");
  const flowing = [35, 36].map((kmh) => ({ edgeId: e.id, kmh, expiresAt: fresh }));
  assert.equal(C.speedLevels(R, flowing, now, free).levels[e.id], "light");
  const old = [5, 5].map((kmh) => ({ edgeId: e.id, kmh, expiresAt: new Date(now - 1000) }));
  assert.deepEqual(C.speedLevels(R, old, now, free).levels, {}, "old readings are ignored");
});

test("Firebase store: reports are shared, confirmed and cleared", async () => {
  const fb = fakeFirebase();
  const userA = C.connect(CONFIG, null, fb.fetchImpl);
  const userB = C.connect(CONFIG, null, fb.fetchImpl);
  assert.equal(userA.mode, "firebase");
  const e = roadEdge();
  const saved = await userA.addReport(C.newReport({ type: "accident", lat: e.geom[0], lon: e.geom[1], edgeId: e.id, roadName: e.name, note: "Lorry overturned" }, new Date()));
  assert.ok(saved.id);
  // Another user sees it.
  const seen = await userB.listReports(new Date());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "accident");
  assert.equal(seen[0].note, "Lorry overturned");
  assert.ok(seen[0].expiresAt instanceof Date && seen[0].createdAt instanceof Date);
  // Confirm once, clear twice: still counts (2 clears, 1 confirm -> cleared).
  await userB.vote(seen[0], "confirm");
  await userA.vote(seen[0], "clear");
  let again = (await userB.listReports(new Date()))[0];
  assert.equal(again.confirms, 1);
  assert.equal(again.clears, 1);
  assert.equal(C.isActive(again, new Date()), true);
  await userB.vote(again, "clear");
  again = (await userB.listReports(new Date()))[0];
  assert.equal(C.isActive(again, new Date()), false, "two people said it is cleared");
  // Expired reports are not returned.
  assert.equal((await userB.listReports(new Date(Date.now() + 3 * 3600000))).length, 0);
});

test("Firebase store: only signed-in admins can post and remove alerts", async () => {
  const fb = fakeFirebase();
  const store = C.connect(CONFIG, null, fb.fetchImpl);
  const alert = { kind: "bandh", title: "Bandh today", message: "Shops closed", edges: [roadEdge().id], startsAt: new Date(), endsAt: new Date(Date.now() + 3600000) };
  await assert.rejects(store.addAlert(alert), (e) => e.code === "denied", "anyone could post an alert");
  await assert.rejects(store.signIn(ADMIN.email, "wrong"), (e) => e.code === "signin");
  assert.equal((await store.signIn(ADMIN.email, ADMIN.password)).email, ADMIN.email);
  const saved = await store.addAlert(alert);
  const list = await store.listAlerts(new Date());
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].edges, alert.edges);
  assert.equal(list[0].title, "Bandh today");
  await store.removeAlert(saved);
  assert.equal((await store.listAlerts(new Date())).length, 0);
  const lastPost = fb.calls.filter((c) => c.method === "POST" && c.url.includes("/alerts?"));
  assert.ok(lastPost.every((c) => !c.auth || c.auth.startsWith("Bearer ")));
});

test("Firebase store: trip speeds are shared anonymously", async () => {
  const fb = fakeFirebase();
  const store = C.connect(CONFIG, null, fb.fetchImpl);
  const e = roadEdge();
  await store.addSpeed({ edgeId: e.id, kmh: 6, vehicle: "car", at: new Date(), expiresAt: new Date(Date.now() + 20 * 60000) });
  const fields = Object.keys(Object.values(fb.db.speeds)[0].fields).sort();
  assert.deepEqual(fields, ["at", "edgeId", "expiresAt", "kmh", "vehicle"], "no user or device data is stored");
  assert.equal((await store.listSpeeds(new Date())).length, 1);
});

test("without Firebase settings, reports stay on this device", async () => {
  const mem = {};
  const storage = { getItem: (k) => mem[k] || null, setItem: (k, v) => { mem[k] = v; } };
  const store = C.connect({ apiKey: "", projectId: "" }, storage, null);
  assert.equal(store.mode, "local");
  await store.addReport(C.newReport({ type: "jam", lat: 18.1, lon: 83.4, edgeId: "r1" }, new Date()));
  const list = await store.listReports(new Date());
  assert.equal(list.length, 1);
  await store.vote(list[0], "confirm");
  assert.equal((await store.listReports(new Date()))[0].confirms, 1);
  await assert.rejects(store.signIn("a", "b"), (e) => e.code === "notconnected");
});
