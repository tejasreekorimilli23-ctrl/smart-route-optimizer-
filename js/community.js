/*
 * Community data: what people and officials report about the roads today.
 *
 *  - Reports: anyone can report an accident, road closure, bandh, flooding,
 *    jam or road works at a point. Others confirm ("still there") or clear
 *    it ("cleared"). Every report expires on its own (see EXPIRY_MINUTES).
 *  - Alerts: signed-in admins (police / municipality) post official alerts,
 *    e.g. a bandh or a planned closure, for the whole city or chosen roads.
 *  - Speeds: in Trip mode, users can share how fast they actually moved on
 *    each road section, anonymously. Several slow readings on a road mean it
 *    is jammed, even if nobody reported anything.
 *
 * Storage: Google Firebase (Cloud Firestore), used through its REST API so
 * no extra library is needed. Fill in js/firebase-config.js to switch it on;
 * firestore.rules holds the matching security rules. Without a config, the
 * "local" store keeps reports on this device only (useful for trying it out).
 *
 * The pure functions (expiry, trust, effects, speed aggregation) decide how
 * reports change the roads; the stores only save and load.
 *
 * Works in the browser (exposes window.Community) and in Node (for tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Community = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TYPES = ["accident", "closed", "bandh", "flooding", "jam", "works", "other"];

  // How long a report stays active without anyone confirming it.
  var EXPIRY_MINUTES = { accident: 120, closed: 12 * 60, flooding: 6 * 60, jam: 60, works: 7 * 24 * 60, other: 120 };
  // A bandh lasts until the end of the day it was reported.

  // What a report does to its road.
  var EFFECTS = {
    accident: { level: "heavy", unsafe: true },
    closed: { level: "closed", unsafe: true },
    bandh: { level: "closed", unsafe: true },
    flooding: { level: "heavy", unsafe: true },
    jam: { level: "heavy", unsafe: false },
    works: { level: "moderate", unsafe: true },
    other: { level: "moderate", unsafe: false }
  };

  var SETTINGS = {
    maxNote: 140,
    timeoutMs: 15000, // a server call with no answer after this fails with "timeout"
    speedMinutes: 20, // shared speeds count for this long
    speedMinReadings: 2, // readings needed before a road's speed is trusted
    lightMinRatio: 0.8, // same rule as live TomTom speeds
    moderateMinRatio: 0.5
  };

  // ---------- rules: expiry, trust, effects ----------

  function expiryFor(type, created) {
    if (type === "bandh") {
      var end = new Date(created.getTime());
      end.setHours(23, 59, 0, 0);
      return end;
    }
    return new Date(created.getTime() + (EXPIRY_MINUTES[type] || 120) * 60000);
  }

  /**
   * A report counts while it has not expired and people have not cleared
   * it: two "cleared" votes (more than the "still there" votes) remove it.
   */
  function isActive(report, now) {
    if (!report || !report.expiresAt || report.expiresAt <= now) return false;
    return !(report.clears >= 2 && report.clears > report.confirms);
  }

  function isAlertActive(alert, now) {
    return !!alert && (!alert.startsAt || alert.startsAt <= now) && (!alert.endsAt || alert.endsAt > now);
  }

  var SEVERITY = { light: 0, moderate: 1, heavy: 2, closed: 3 };

  function worse(levels, id, level) {
    if (!levels[id] || SEVERITY[level] > SEVERITY[levels[id]]) levels[id] = level;
  }

  /**
   * Effect of active reports and alerts on the roads:
   * { levels: { edgeId: level }, unsafe: [edgeIds], byEdge: { edgeId: report } }
   * Alerts list their roads in `edges`; alert kinds use the same effects
   * ("closure" closes, "bandh" closes, others make roads heavy).
   */
  function effects(reports, alerts, now) {
    var levels = {};
    var unsafe = {};
    var byEdge = {};
    (reports || []).forEach(function (r) {
      if (!isActive(r, now) || !r.edgeId) return;
      var fx = EFFECTS[r.type] || EFFECTS.other;
      worse(levels, r.edgeId, fx.level);
      if (fx.unsafe) unsafe[r.edgeId] = true;
      if (!byEdge[r.edgeId] || SEVERITY[fx.level] > SEVERITY[(EFFECTS[byEdge[r.edgeId].type] || EFFECTS.other).level]) byEdge[r.edgeId] = r;
    });
    (alerts || []).forEach(function (a) {
      if (!isAlertActive(a, now)) return;
      var level = a.kind === "closure" || a.kind === "bandh" ? "closed" : "heavy";
      (a.edges || []).forEach(function (id) {
        worse(levels, id, level);
        unsafe[id] = true;
        if (!byEdge[id]) byEdge[id] = { type: a.kind === "closure" ? "closed" : a.kind, alert: a };
      });
    });
    return { levels: levels, unsafe: Object.keys(unsafe), byEdge: byEdge };
  }

  /**
   * Shared speeds -> traffic levels. For each road with at least
   * speedMinReadings fresh readings, the median speed is compared with the
   * road's free-flow speed (for cars), with the same thresholds as live
   * TomTom speeds. Returns { levels, roads }.
   */
  function speedLevels(data, speeds, now, freeFlowKmh) {
    var byEdge = {};
    (speeds || []).forEach(function (s) {
      if (!s || !s.edgeId || !(s.kmh >= 0) || (s.expiresAt && s.expiresAt <= now)) return;
      (byEdge[s.edgeId] = byEdge[s.edgeId] || []).push(s.kmh);
    });
    var levels = {};
    var edgeById = {};
    data.EDGES.forEach(function (e) { edgeById[e.id] = e; });
    Object.keys(byEdge).forEach(function (id) {
      var list = byEdge[id].sort(function (a, b) { return a - b; });
      var e = edgeById[id];
      if (!e || list.length < SETTINGS.speedMinReadings) return;
      var mid = list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2;
      var free = freeFlowKmh(e);
      if (!(free > 0)) return;
      var ratio = mid / free;
      levels[id] = ratio >= SETTINGS.lightMinRatio ? "light" : ratio >= SETTINGS.moderateMinRatio ? "moderate" : "heavy";
    });
    return { levels: levels, roads: Object.keys(levels).length };
  }

  /** Checks a new report before saving. Returns an error code or null. */
  function validateReport(r) {
    if (!r || TYPES.indexOf(r.type) < 0) return "type";
    if (typeof r.lat !== "number" || typeof r.lon !== "number" || !isFinite(r.lat) || !isFinite(r.lon)) return "place";
    if (r.note && String(r.note).length > SETTINGS.maxNote) return "note";
    return null;
  }

  function newReport(input, now) {
    return {
      type: input.type,
      lat: Math.round(input.lat * 1e5) / 1e5,
      lon: Math.round(input.lon * 1e5) / 1e5,
      edgeId: input.edgeId || "",
      roadName: input.roadName || "",
      note: String(input.note || "").slice(0, SETTINGS.maxNote),
      createdAt: now,
      expiresAt: expiryFor(input.type, now),
      confirms: 0,
      clears: 0,
      area: input.area || ""
    };
  }

  // ---------- Firestore REST encoding ----------

  function toValue(v) {
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
    if (v === null || v === undefined) return { nullValue: null };
    return { stringValue: String(v) };
  }

  function fromValue(v) {
    if (!v) return null;
    if ("timestampValue" in v) return new Date(v.timestampValue);
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("booleanValue" in v) return !!v.booleanValue;
    if ("stringValue" in v) return v.stringValue;
    if ("arrayValue" in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fromValue);
    return null;
  }

  function toFields(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k] = toValue(obj[k]); });
    return out;
  }

  function fromDoc(doc) {
    var out = { id: doc.name.split("/").pop(), path: doc.name };
    Object.keys(doc.fields || {}).forEach(function (k) { out[k] = fromValue(doc.fields[k]); });
    return out;
  }

  function failure(code, status) {
    var err = new Error("Community store: " + code + (status ? " (HTTP " + status + ")" : ""));
    err.code = code;
    return err;
  }

  // ---------- Firebase store ----------

  /**
   * Store backed by Cloud Firestore. config: { apiKey, projectId }.
   * fetchImpl(url, options) -> Promise<Response-like>.
   */
  function firebaseStore(config, fetchImpl) {
    var doFetch = fetchImpl || (typeof fetch === "function" ? function (u, o) { return fetch(u, o); } : null);
    var dbPath = "projects/" + config.projectId + "/databases/(default)/documents";
    var base = "https://firestore.googleapis.com/v1/" + dbPath;
    var key = "key=" + encodeURIComponent(config.apiKey);
    var token = null; // admin sign-in

    function call(url, options) {
      var req;
      try {
        req = Promise.resolve(doFetch(url, options));
      } catch (err) {
        req = Promise.reject(err);
      }
      req = new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(failure("timeout")); }, SETTINGS.timeoutMs);
        req.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
      });
      return req.then(function (res) {
        if (res.status === 401 || res.status === 403) throw failure("denied", res.status);
        if (res.status === 429) throw failure("limit", res.status);
        if (!res.ok) throw failure("failed", res.status);
        return res.status === 204 ? null : res.json();
      }, function (err) {
        throw err && err.code === "timeout" ? err : failure("offline");
      });
    }

    function json(method, body, auth) {
      var headers = { "Content-Type": "application/json" };
      if (auth && token) headers.Authorization = "Bearer " + token.idToken;
      return { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) };
    }

    /** Documents of a collection whose `field` is later than `after`. */
    function listAfter(collection, field, after, limit) {
      return call(base + ":runQuery?" + key, json("POST", {
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN", value: toValue(after) } },
          limit: limit || 300
        }
      })).then(function (rows) {
        return (rows || []).filter(function (r) { return r.document; }).map(function (r) { return fromDoc(r.document); });
      });
    }

    function create(collection, obj, auth) {
      return call(base + "/" + collection + "?" + key, json("POST", { fields: toFields(obj) }, auth)).then(fromDoc);
    }

    return {
      mode: "firebase",
      listReports: function (now) { return listAfter("reports", "expiresAt", now); },
      addReport: function (r) { return create("reports", r); },
      /** kind: "confirm" or "clear"; increments the counter on the server. */
      vote: function (report, kind) {
        var field = kind === "clear" ? "clears" : "confirms";
        return call(base + ":commit?" + key, json("POST", {
          writes: [{
            transform: {
              document: report.path,
              fieldTransforms: [{ fieldPath: field, increment: { integerValue: "1" } }]
            }
          }]
        }));
      },
      /** Admins only: removes a report (e.g. a false one). */
      removeReport: function (report) {
        return call("https://firestore.googleapis.com/v1/" + report.path + "?" + key, json("DELETE", undefined, true));
      },
      listAlerts: function (now) { return listAfter("alerts", "endsAt", now); },
      addAlert: function (a) { return create("alerts", a, true); },
      removeAlert: function (alert) {
        return call("https://firestore.googleapis.com/v1/" + alert.path + "?" + key, json("DELETE", undefined, true));
      },
      listSpeeds: function (now) { return listAfter("speeds", "expiresAt", now); },
      addSpeed: function (s) { return create("speeds", s); },
      /** Admin sign-in with a Firebase Authentication email + password. */
      signIn: function (email, password) {
        return call("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?" + key,
          json("POST", { email: email, password: password, returnSecureToken: true }))
          .then(function (res) {
            token = { idToken: res.idToken, email: res.email };
            return { email: res.email };
          }, function (err) {
            if (err.code === "failed") throw failure("signin");
            throw err;
          });
      },
      signOut: function () { token = null; },
      signedIn: function () { return token ? token.email : null; }
    };
  }

  // ---------- local store (this device only) ----------

  function localStore(storage) {
    var KEY = "community-local";
    function load() {
      try {
        var raw = JSON.parse(storage.getItem(KEY) || "{}");
        ["reports", "speeds"].forEach(function (c) {
          raw[c] = (raw[c] || []).map(function (d) {
            ["createdAt", "expiresAt", "at"].forEach(function (f) { if (d[f]) d[f] = new Date(d[f]); });
            return d;
          });
        });
        return raw;
      } catch (err) {
        return { reports: [], speeds: [] };
      }
    }
    function save(db) {
      try { storage.setItem(KEY, JSON.stringify(db)); } catch (err) { /* full or blocked: ignore */ }
    }
    var counter = 0;
    return {
      mode: "local",
      listReports: function (now) {
        return Promise.resolve(load().reports.filter(function (r) { return r.expiresAt > now; }));
      },
      addReport: function (r) {
        var db = load();
        var doc = Object.assign({ id: "local-" + Date.now() + "-" + counter++ }, r);
        db.reports.push(doc);
        save(db);
        return Promise.resolve(doc);
      },
      vote: function (report, kind) {
        var db = load();
        db.reports.forEach(function (r) {
          if (r.id === report.id) r[kind === "clear" ? "clears" : "confirms"]++;
        });
        save(db);
        return Promise.resolve(null);
      },
      removeReport: function (report) {
        var db = load();
        db.reports = db.reports.filter(function (r) { return r.id !== report.id; });
        save(db);
        return Promise.resolve(null);
      },
      listAlerts: function () { return Promise.resolve([]); },
      addAlert: function () { return Promise.reject(failure("notconnected")); },
      removeAlert: function () { return Promise.reject(failure("notconnected")); },
      listSpeeds: function () { return Promise.resolve([]); },
      addSpeed: function () { return Promise.resolve(null); }, // nobody else would see it
      signIn: function () { return Promise.reject(failure("notconnected")); },
      signOut: function () {},
      signedIn: function () { return null; }
    };
  }

  /** Firebase store if the config is filled in, else the local store. */
  function connect(config, storage, fetchImpl) {
    if (config && config.apiKey && config.projectId) return firebaseStore(config, fetchImpl);
    return localStore(storage);
  }

  return {
    TYPES: TYPES,
    EFFECTS: EFFECTS,
    EXPIRY_MINUTES: EXPIRY_MINUTES,
    SETTINGS: SETTINGS,
    expiryFor: expiryFor,
    isActive: isActive,
    isAlertActive: isAlertActive,
    effects: effects,
    speedLevels: speedLevels,
    validateReport: validateReport,
    newReport: newReport,
    toFields: toFields,
    fromDoc: fromDoc,
    firebaseStore: firebaseStore,
    localStore: localStore,
    connect: connect
  };
});
