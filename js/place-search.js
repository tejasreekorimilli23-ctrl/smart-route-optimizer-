/*
 * Place search box: type part of a name ("maha", "thota", "hosp") and pick
 * from the suggestions. Keyboard: Up/Down to move, Enter to choose, Escape to
 * close. Follows the WAI-ARIA combobox pattern so screen readers announce it.
 * Exposes window.PlaceSearch.
 */
(function (root) {
  "use strict";

  var MAX_RESULTS = 8;

  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  /**
   * Ranks items for a query. Every word of the query must appear in the
   * item's text; names that start with the query come first.
   * items: [{ id, label, sub, keywords }]
   */
  function rank(items, query) {
    var q = norm(query);
    if (!q) return [];
    var words = q.split(" ");
    var out = [];
    items.forEach(function (it) {
      var name = norm(it.label);
      var all = name + " " + norm(it.keywords || "") + " " + norm(it.sub || "");
      if (!words.every(function (w) { return all.indexOf(w) >= 0; })) return;
      var score = name.indexOf(q) === 0 ? 0 : (" " + name).indexOf(" " + words[0]) >= 0 ? 1 : name.indexOf(words[0]) >= 0 ? 2 : 3;
      out.push({ item: it, score: score });
    });
    out.sort(function (a, b) {
      return a.score - b.score || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label);
    });
    return out.slice(0, MAX_RESULTS).map(function (x) { return x.item; });
  }

  /**
   * opts: {
   *   input, list: elements;
   *   items(): current items;
   *   extras(query): items always offered first (e.g. "Use my location");
   *   onPick(item): called when the user chooses;
   *   emptyText(): text shown when nothing matches
   * }
   */
  function attach(opts) {
    var input = opts.input;
    var list = opts.list;
    var shown = [];
    var active = -1;
    var idBase = list.id + "-opt-";

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("autocomplete", "off");
    list.setAttribute("role", "listbox");

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function highlight(i) {
      active = i;
      Array.prototype.forEach.call(list.children, function (li, k) {
        li.setAttribute("aria-selected", k === i ? "true" : "false");
      });
      if (i >= 0 && list.children[i]) {
        input.setAttribute("aria-activedescendant", list.children[i].id);
        list.children[i].scrollIntoView({ block: "nearest" });
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function render() {
      var q = input.value;
      shown = (opts.extras ? opts.extras(q) : []).concat(rank(opts.items(), q));
      list.innerHTML = "";
      if (!shown.length) {
        if (!q.trim()) { close(); return; }
        var none = document.createElement("li");
        none.className = "ps-empty";
        none.setAttribute("role", "presentation");
        none.textContent = opts.emptyText();
        list.appendChild(none);
      }
      shown.forEach(function (it, i) {
        var li = document.createElement("li");
        li.id = idBase + i;
        li.setAttribute("role", "option");
        li.className = "ps-option" + (it.special ? " is-special" : "");
        var name = document.createElement("span");
        name.className = "ps-name";
        name.textContent = it.label;
        li.appendChild(name);
        if (it.sub) {
          var sub = document.createElement("span");
          sub.className = "ps-sub";
          sub.textContent = it.sub;
          li.appendChild(sub);
        }
        // mousedown (not click) so the input does not lose focus first.
        li.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          pick(i);
        });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(shown.length ? 0 : -1);
    }

    function pick(i) {
      var it = shown[i];
      if (!it) return;
      close();
      opts.onPick(it);
    }

    input.addEventListener("input", render);
    input.addEventListener("focus", function () {
      input.select();
      if (opts.extras && opts.extras("").length) render();
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (list.hidden) render();
        else highlight(Math.min(shown.length - 1, active + 1));
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        highlight(Math.max(0, active - 1));
      } else if (ev.key === "Enter") {
        if (!list.hidden && active >= 0) {
          ev.preventDefault();
          pick(active);
        }
      } else if (ev.key === "Escape") {
        if (!list.hidden) {
          ev.preventDefault();
          close();
        }
      }
    });
    input.addEventListener("blur", function () {
      close();
      if (opts.onBlur) opts.onBlur();
    });

    return { close: close, render: render };
  }

  root.PlaceSearch = { attach: attach, rank: rank };
})(typeof self !== "undefined" ? self : this);
