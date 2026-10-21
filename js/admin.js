/*
 * Admin page (admin.html): official alerts and moderation of public reports.
 * Admins sign in with a Firebase Authentication account that has a matching
 * admins/<uid> document (see js/firebase-config.js and firestore.rules).
 */
(function () {
  "use strict";

  var C = window.Community;
  var AL = window.AreaLoader;
  var BUILT_IN = window.RealTrafficData;

  function $(id) {
    return document.getElementById(id);
  }

  var cfg = window.FIREBASE_CONFIG || {};
  if (!C || !cfg.apiKey || !cfg.projectId) {
    $("not-set-up").hidden = false;
    return;
  }
  var store = C.connect(cfg, window.localStorage);
  var data = BUILT_IN;
  var chosen = {}; // edgeId -> true
  var map = null;
  var roadLayer = null;
  var lines = {};

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function localInput(date) {
    var d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }

  function errorText(err) {
    return {
      signin: "Wrong email or password.",
      denied: "This account is not an admin (add admins/<uid> in Firestore), or the rules were not published.",
      offline: "No internet connection.",
      limit: "Firebase is busy. Try again in a minute."
    }[err && err.code] || "That did not work. Try again.";
  }

  // ---------- sign in ----------

  $("sign-in").hidden = false;
  $("sign-in-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("sign-in-error");
    err.hidden = true;
    store.signIn($("admin-email").value.trim(), $("admin-password").value).then(function (who) {
      $("admin-password").value = "";
      $("sign-in").hidden = true;
      $("admin-area").hidden = false;
      $("admin-who").textContent = "Signed in as " + who.email + ".";
      start();
    }, function (e) {
      err.textContent = errorText(e);
      err.hidden = false;
    });
  });
  $("sign-out").addEventListener("click", function () {
    store.signOut();
    window.location.reload();
  });

  // ---------- map: click roads to choose them ----------

  function drawRoads() {
    if (!map) {
      map = window.L.map("admin-map", { preferCanvas: true });
      window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
    }
    if (roadLayer) map.removeLayer(roadLayer);
    roadLayer = window.L.layerGroup().addTo(map);
    lines = {};
    chosen = {};
    var renderer = window.L.canvas({ tolerance: 6 });
    data.EDGES.forEach(function (e) {
      if (!e.geom || e.type === "access") return;
      var ll = [];
      for (var i = 0; i < e.geom.length; i += 2) ll.push([e.geom[i], e.geom[i + 1]]);
      var line = window.L.polyline(ll, { renderer: renderer, color: "#5B6B86", weight: e.corridor ? 4 : 2.5, opacity: 0.55 });
      line.bindTooltip(esc(e.name));
      line.on("click", function () { toggle(e.corridor ? e.corridor : null, e.id); });
      line.addTo(roadLayer);
      lines[e.id] = line;
    });
    map.setView(data.AREA.center, data.AREA.zoom);
    showChosen();
  }

  /** Clicking a named road chooses every section of it; unnamed: just that section. */
  function toggle(corridor, id) {
    var ids = corridor ? data.EDGES.filter(function (e) { return e.corridor === corridor; }).map(function (e) { return e.id; }) : [id];
    var on = !chosen[id];
    ids.forEach(function (x) {
      if (on) chosen[x] = true;
      else delete chosen[x];
      if (lines[x]) lines[x].setStyle(on ? { color: "#C62828", weight: 7, opacity: 1 } : { color: "#5B6B86", weight: 4, opacity: 0.55 });
    });
    showChosen();
  }

  function showChosen() {
    var names = {};
    Object.keys(chosen).forEach(function (id) {
      var e = data.EDGES.filter(function (x) { return x.id === id; })[0];
      if (e) names[e.corridor || e.name] = true;
    });
    var list = Object.keys(names);
    $("chosen-roads").textContent = list.length ? "Chosen roads: " + list.join(", ") + "." : "No roads chosen (banner only).";
  }

  // ---------- areas ----------

  function fillAreas() {
    var sel = $("alert-area");
    sel.innerHTML = "";
    sel.add(new Option(BUILT_IN.AREA.name + " (built in)", "builtin"));
    (AL ? AL.list() : Promise.resolve([])).then(function (saved) {
      saved.forEach(function (a) { sel.add(new Option(a.name, a.key)); });
    });
    sel.addEventListener("change", function () {
      if (sel.value === "builtin") {
        data = BUILT_IN;
        drawRoads();
        return;
      }
      AL.recall(sel.value).then(function (d) {
        if (d) {
          data = d;
          drawRoads();
        }
      });
    });
  }

  // ---------- alerts and reports ----------

  function refreshLists() {
    var now = new Date();
    store.listAlerts(now).then(function (alerts) {
      $("alert-list").innerHTML = alerts.length ? alerts.map(function (a, i) {
        return "<li><strong>" + esc(a.title || a.kind) + "</strong> · " + esc(a.kind) + " · until " + esc(a.endsAt ? a.endsAt.toLocaleString() : "?") +
          " · " + (Array.isArray(a.edges) ? a.edges.length : 0) + " road sections " +
          '<button type="button" class="btn-secondary" data-remove-alert="' + i + '">Remove</button></li>';
      }).join("") : "<li>No active alerts.</li>";
      $("alert-list").onclick = function (ev) {
        var b = ev.target.closest("[data-remove-alert]");
        if (!b) return;
        store.removeAlert(alerts[Number(b.getAttribute("data-remove-alert"))]).then(refreshLists, function (e) { window.alert(errorText(e)); });
      };
    });
    store.listReports(now).then(function (reports) {
      reports = reports.filter(function (r) { return C.isActive(r, now); });
      $("report-list").innerHTML = reports.length ? reports.map(function (r, i) {
        return "<li><strong>" + esc(r.type) + "</strong> · " + esc(r.roadName || "") + " · " + esc(r.area || "") + " · " +
          esc(r.createdAt ? r.createdAt.toLocaleString() : "") + " · ✓" + esc(String(r.confirms)) + " ✗" + esc(String(r.clears)) +
          (r.note ? " · “" + esc(r.note) + "”" : "") +
          ' <button type="button" class="btn-secondary" data-remove-report="' + i + '">Remove</button></li>';
      }).join("") : "<li>No active reports.</li>";
      $("report-list").onclick = function (ev) {
        var b = ev.target.closest("[data-remove-report]");
        if (!b) return;
        store.removeReport(reports[Number(b.getAttribute("data-remove-report"))]).then(refreshLists, function (e) { window.alert(errorText(e)); });
      };
    });
  }

  $("alert-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("alert-error");
    err.hidden = true;
    var title = $("alert-title").value.trim();
    var starts = new Date($("alert-start").value);
    var ends = new Date($("alert-end").value);
    if (!title) {
      err.textContent = "Give the alert a title.";
      err.hidden = false;
      return;
    }
    if (!(ends > starts)) {
      err.textContent = "'Until' must be after 'From'.";
      err.hidden = false;
      return;
    }
    store.addAlert({
      kind: $("alert-kind").value,
      title: title,
      message: $("alert-message").value.trim(),
      edges: Object.keys(chosen),
      area: data.AREA.name,
      startsAt: starts,
      endsAt: ends
    }).then(function () {
      $("alert-done").textContent = "Alert posted. Users see it within a minute.";
      $("alert-title").value = "";
      $("alert-message").value = "";
      refreshLists();
    }, function (e) {
      err.textContent = errorText(e);
      err.hidden = false;
    });
  });

  function start() {
    var now = new Date();
    $("alert-start").value = localInput(now);
    $("alert-end").value = localInput(new Date(now.getTime() + 6 * 3600000));
    fillAreas();
    drawRoads();
    refreshLists();
  }
})();
