/*
 * Builds dist/smart-traffic-route-optimizer.html: one self-contained file with
 * the CSS and JavaScript inlined. Handy for emailing, a pen drive, or hosting.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let html = read("index.html");

html = html.replace(/<link rel="stylesheet" href="(css\/[^"]+)">/g, (_, file) =>
  "<style>\n" + read(file) + "\n</style>"
);
html = html.replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, file) =>
  // Guard against a literal "</script" inside the code closing the tag early.
  "<script>\n" + read(file).replace(/<\/script/gi, "<\\/script") + "\n</script>"
);

if (/(?:src|href)="(?:js|css)\//.test(html)) {
  console.error("Build failed: some local files were not inlined.");
  process.exit(1);
}
fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
const out = path.join(ROOT, "dist", "smart-traffic-route-optimizer.html");
fs.writeFileSync(out, html);
console.log(`Built ${path.relative(ROOT, out)} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
