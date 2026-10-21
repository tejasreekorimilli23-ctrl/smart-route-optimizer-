/*
 * Draws the app icons (icons/icon-192.png, icons/icon-512.png and a
 * "maskable" version with extra margin) with no image libraries:
 * a navy square with a cyan route line between two points.
 *     node scripts/make-icons.js
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const NAVY = [13, 28, 54];
const CYAN = [63, 216, 234];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size);
      const i = y * (size * 3 + 1) + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The picture, in 0..1 coordinates; `pad` shrinks it for maskable icons. */
function icon(pad) {
  const s = (v) => pad + v * (1 - 2 * pad);
  const route = [[0.22, 0.78], [0.22, 0.5], [0.55, 0.5], [0.55, 0.26], [0.78, 0.26]].map(([x, y]) => [s(x), s(y)]);
  const start = route[0];
  const end = route[route.length - 1];
  const w = 0.075 * (1 - 2 * pad);
  return (x, y) => {
    if (Math.hypot(x - end[0], y - end[1]) < w * 1.6) return Math.hypot(x - end[0], y - end[1]) < w * 0.7 ? CYAN : NAVY;
    if (Math.hypot(x - end[0], y - end[1]) < w * 2.2) return CYAN;
    if (Math.hypot(x - start[0], y - start[1]) < w * 1.5) return WHITE;
    for (let i = 1; i < route.length; i++) {
      if (distToSegment(x, y, ...route[i - 1], ...route[i]) < w / 2) return CYAN;
    }
    return NAVY;
  };
}

const out = path.resolve(__dirname, "..", "icons");
fs.mkdirSync(out, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, icon(0.08)));
  fs.writeFileSync(path.join(out, `icon-maskable-${size}.png`), png(size, icon(0.2)));
}
console.log("Icons written to icons/");
