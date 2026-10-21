/*
 * English -> Telugu transliteration of place and road names. Run with: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../js/translit.js");
const R = require("../js/real-network-data.js");

test("known names and common words use correct Telugu", () => {
  assert.equal(T.toTelugu("Thotapalem"), "తోటపాలెం");
  assert.equal(T.toTelugu("Vizianagaram Junction"), "విజయనగరం జంక్షన్");
  assert.equal(T.toTelugu("Railway Station Road"), "రైల్వే స్టేషన్ రోడ్డు");
  assert.equal(T.toTelugu("Gandhi Nagar"), "గాంధీ నగర్");
  assert.equal(T.toTelugu("Kotha Agraharam - Gajula Rega Road"), "కొత్త అగ్రహారం - గాజుల రేగ రోడ్డు");
  assert.equal(T.toTelugu("Government Hospital (near Gajula Rega)"), "ప్రభుత్వ ఆసుపత్రి (గాజులరేగ దగ్గర)");
});

test("letters, abbreviations and sounds", () => {
  assert.equal(T.toTelugu("R T C Complex"), "ఆర్ టి సి కాంప్లెక్స్");
  assert.ok(T.toTelugu("NCS Multiplex").startsWith("ఎన్\u200cసి\u200cఎస్"));
  assert.equal(T.phonetic("tirumala"), "తిరుమల");
  assert.equal(T.phonetic("pradeep"), "ప్రదీప్");
  assert.equal(T.phonetic("ganga"), "గంగ", "n before g is an anusvara");
  assert.equal(T.phonetic("kanyaka"), "కన్యక", "but not before y");
  assert.equal(T.toTelugu("తోటపాలెం"), "తోటపాలెం", "Telugu text is left as it is");
});

test("every place and road name on the map becomes Telugu script", () => {
  const names = new Set(R.NODES.filter((n) => n.category).map((n) => n.name));
  R.EDGES.forEach((e) => e.corridor && names.add(e.corridor));
  for (const name of names) {
    const te = T.toTelugu(name);
    assert.ok(!/[A-Za-z]/.test(te), name + " -> " + te + " still has English letters");
    assert.ok(/[\u0C00-\u0C7F]/.test(te) || !/[A-Za-z]/.test(name), name + " -> " + te + " has no Telugu");
  }
});
