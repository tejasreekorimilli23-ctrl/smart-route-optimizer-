/*
 * Lightweight checks with no dependencies:
 *  - every JavaScript file parses (node --check)
 *  - every element id that app.js looks up exists in index.html
 *  - every script and stylesheet referenced by index.html exists
 */
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
let failures = 0;
const fail = (msg) => { console.error("FAIL  " + msg); failures++; };
const pass = (msg) => console.log("ok    " + msg);

const jsFiles = ["js", "scripts", "tests"].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.(c?js)$/.test(f)).map((f) => path.join(dir, f))
);
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    pass("syntax " + f);
  } catch (e) {
    fail("syntax " + f + "\n" + e.stderr.toString());
  }
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const app = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const wanted = [...app.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
const missing = wanted.filter((id) => !ids.has(id));
if (missing.length) fail("index.html is missing ids used by app.js: " + missing.join(", "));
else pass(`all ${wanted.length} element ids used by app.js exist in index.html`);

const refs = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map((m) => m[1]);
const absent = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
if (absent.length) fail("index.html references missing files: " + absent.join(", "));
else pass(`all ${refs.length} local files referenced by index.html exist`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
