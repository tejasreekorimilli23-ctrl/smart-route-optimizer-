/*
 * English (Latin letters) to Telugu script, for place and road names that
 * OpenStreetMap only has in English.
 *
 *  1. Known names (NAMES) use their correct Telugu spelling.
 *  2. Common English words in names (road, hospital, nagar, colony...) are
 *     translated or written the way Telugu speakers say them (WORDS).
 *  3. Single letters and short all-capital abbreviations are read out
 *     letter by letter: "R T C" -> "ఆర్ టి సి".
 *  4. Everything else is transliterated by sound, the way Indian names are
 *     usually written in English: "th" = త, "t" = ట, "dh" = ధ, "o" = ఓ,
 *     a final "m" = ం (Thotapalem -> తోటపలెం).
 *
 * Automatic transliteration cannot know long vowels that English spelling
 * hides (pa/paa), so results are close but not always perfect. Add correct
 * spellings to NAMES as you find them.
 *
 * Works in the browser (exposes window.Translit) and in Node.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Translit = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Exact Telugu spellings of whole names (lower case English -> Telugu).
  var NAMES = {
    "vizianagaram": "విజయనగరం",
    "vizianagaram junction": "విజయనగరం జంక్షన్",
    "thotapalem": "తోటపాలెం",
    "gajula rega": "గాజులరేగ",
    "kothagraharam": "కొత్తగ్రహారం",
    "kanapaka": "కనపాక",
    "dharmapuri": "ధర్మపురి",
    "gokavanipeta": "గోకవానిపేట",
    "chillapeta": "చిల్లపేట",
    "padalapeta": "పాడాలపేట",
    "jammunarayanapuram": "జమ్ము నారాయణపురం",
    "kadipeta": "కడిపేట",
    "phool bagh": "ఫూల్ బాగ్",
    "hanuman nagar": "హనుమాన్ నగర్",
    "clock tower junction": "క్లాక్ టవర్ జంక్షన్",
    "clock tower": "క్లాక్ టవర్",
    "maharaja district hospital, vizianagaram": "మహారాజా జిల్లా ఆసుపత్రి, విజయనగరం",
    "maharajah's college": "మహారాజా కళాశాల",
    "government hospital": "ప్రభుత్వ ఆసుపత్రి",
    "mg road": "ఎం.జి. రోడ్డు",
    "visakhapatnam": "విశాఖపట్నం",
    "hyderabad": "హైదరాబాద్",
    "vijayawada": "విజయవాడ",
    "guntur": "గుంటూరు",
    "srikakulam": "శ్రీకాకుళం",
    "rajahmundry": "రాజమండ్రి",
    "kakinada": "కాకినాడ",
    "tirupati": "తిరుపతి",
    "nellore": "నెల్లూరు",
    "warangal": "వరంగల్"
  };

  // Common words inside names.
  var WORDS = {
    road: "రోడ్డు", rd: "రోడ్డు", street: "వీధి", st: "వీధి", lane: "సందు", main: "మెయిన్",
    nagar: "నగర్", colony: "కాలనీ", layout: "లేఅవుట్", junction: "జంక్షన్", circle: "సర్కిల్",
    hospital: "ఆసుపత్రి", hospitals: "ఆసుపత్రి", hospial: "ఆసుపత్రి", clinic: "క్లినిక్",
    nursing: "నర్సింగ్", home: "హోమ్", eye: "కంటి", dental: "దంత", children: "పిల్లల",
    college: "కళాశాల", school: "పాఠశాల", high: "హై", junior: "జూనియర్", degree: "డిగ్రీ",
    university: "విశ్వవిద్యాలయం", polytechnic: "పాలిటెక్నిక్", pharmacy: "ఫార్మసీ",
    government: "ప్రభుత్వ", govt: "ప్రభుత్వ", district: "జిల్లా", office: "కార్యాలయం",
    temple: "ఆలయం", church: "చర్చి", mosque: "మసీదు", masjid: "మసీదు",
    bus: "బస్", stand: "స్టాండ్", station: "స్టేషన్", railway: "రైల్వే", stop: "స్టాప్",
    market: "మార్కెట్", complex: "కాంప్లెక్స్", shopping: "షాపింగ్", mall: "మాల్", bazar: "బజార్", bazaar: "బజార్",
    bank: "బ్యాంక్", police: "పోలీస్", fire: "ఫైర్", park: "పార్క్", theatre: "థియేటర్", theater: "థియేటర్",
    area: "ప్రాంతం", town: "టౌన్", city: "సిటీ", fort: "ఫోర్ట్", tank: "ట్యాంక్", lake: "లేక్",
    lodge: "లాడ్జ్", multiplex: "మల్టీప్లెక్స్", bungalow: "బంగ్లా", medicover: "మెడికవర్", hotel: "హోటల్",
    store: "స్టోర్", stores: "స్టోర్స్", shop: "షాప్", petrol: "పెట్రోల్", bunk: "బంక్", pump: "పంప్",
    function: "ఫంక్షన్", hall: "హాల్", club: "క్లబ్", stadium: "స్టేడియం", ground: "గ్రౌండ్",
    apollo: "అపోలో", cinema: "సినిమా", post: "పోస్ట్", library: "లైబ్రరీ", municipal: "మున్సిపల్",
    sai: "సాయి", venkata: "వెంకట", venkateswara: "వెంకటేశ్వర", rama: "రామ", krishna: "కృష్ణ",
    lakshmi: "లక్ష్మి", gandhi: "గాంధీ", nehru: "నెహ్రూ", raju: "రాజు", rao: "రావు", reddy: "రెడ్డి",
    petroleum: "పెట్రోలియం", state: "స్టేట్", india: "ఇండియా", bharat: "భారత్", indian: "ఇండియన్",
    maharaja: "మహారాజా", maharajah: "మహారాజా", graduate: "గ్రాడ్యుయేట్", post: "పోస్ట్", diploma: "డిప్లొమా",
    narayana: "నారాయణ", aditya: "ఆదిత్య", gayatri: "గాయత్రి", saint: "సెయింట్", mary: "మేరీ", st: "వీధి",
    model: "మోడల్", girls: "బాలికల", boys: "బాలుర", visually: "విజువల్లీ", impaired: "ఇంపెయిర్డ్",
    cut: "కట్", piece: "పీస్", brothers: "బ్రదర్స్", trends: "ట్రెండ్స్", future: "ఫ్యూచర్", sale: "సేల్",
    gajula: "గాజుల", rega: "రేగ", kotha: "కొత్త", agraharam: "అగ్రహారం", bagh: "బాగ్", peta: "పేట",
    palem: "పాలెం", puram: "పురం", pet: "పేట", nagaram: "నగరం", gudem: "గూడెం", padu: "పాడు", wada: "వాడ",
    family: "ఫ్యామిలీ", lucky: "లక్కీ", chennai: "చెన్నై", south: "దక్షిణ", junction: "జంక్షన్",
    bund: "బండ్", upper: "అప్పర్", lower: "లోయర్", new: "న్యూ", old: "పాత", north: "ఉత్తర", south: "దక్షిణ",
    east: "తూర్పు", west: "పడమర", and: "మరియు", of: "", the: "", near: "దగ్గర", guest: "గెస్ట్", house: "హౌస్",
    gate: "గేట్", bridge: "వంతెన", centre: "సెంటర్", center: "సెంటర్", health: "హెల్త్", care: "కేర్",
    super: "సూపర్", speciality: "స్పెషాలిటీ", multispeciality: "మల్టీస్పెషాలిటీ", memorial: "మెమోరియల్",
    mother: "తల్లి", child: "పిల్లల", sri: "శ్రీ", sree: "శ్రీ", shri: "శ్రీ", dr: "డా."
  };

  var LETTERS = {
    a: "ఏ", b: "బి", c: "సి", d: "డి", e: "ఈ", f: "ఎఫ్", g: "జి", h: "హెచ్", i: "ఐ", j: "జె", k: "కె",
    l: "ఎల్", m: "ఎం", n: "ఎన్", o: "ఓ", p: "పి", q: "క్యూ", r: "ఆర్", s: "ఎస్", t: "టి", u: "యు",
    v: "వి", w: "డబ్ల్యు", x: "ఎక్స్", y: "వై", z: "జెడ్"
  };

  // Consonants, longest spellings first.
  var CONSONANTS = [
    ["ksh", "క్ష"], ["chh", "ఛ"], ["sh", "శ"], ["ch", "చ"], ["th", "త"], ["dh", "ధ"], ["bh", "భ"], ["ph", "ఫ"],
    ["kh", "ఖ"], ["gh", "ఘ"], ["jh", "ఝ"], ["ck", "క"], ["k", "క"], ["g", "గ"], ["c", "క"], ["j", "జ"],
    ["tt", "ట్ట"], ["dd", "డ్డ"], ["t", "త"], ["d", "ద"], ["n", "న"], ["p", "ప"], ["b", "బ"], ["m", "మ"], ["y", "య"], ["r", "ర"],
    ["l", "ల"], ["v", "వ"], ["w", "వ"], ["s", "స"], ["h", "హ"], ["f", "ఫ"], ["z", "జ"], ["q", "క"]
  ];
  // Vowels: [spelling, letter at the start, sign after a consonant].
  var VOWELS = [
    ["aa", "ఆ", "ా"], ["ai", "ఐ", "ై"], ["au", "ఔ", "ౌ"], ["ee", "ఈ", "ీ"], ["ii", "ఈ", "ీ"], ["oo", "ఊ", "ూ"],
    ["ou", "ఔ", "ౌ"], ["uu", "ఊ", "ూ"], ["a", "అ", ""], ["i", "ఇ", "ి"], ["u", "ఉ", "ు"], ["e", "ఎ", "ె"],
    ["o", "ఓ", "ో"]
  ];
  var VIRAMA = "్";
  var ANUSVARA = "ం";

  function startsWith(s, i, part) {
    return s.substr(i, part.length) === part;
  }

  /** Sound-based transliteration of one lower-case word of letters. */
  function phonetic(word) {
    // A silent final "e" after a consonant, as in English spellings (Lodge, Rose).
    if (word.length > 3 && /[bcdfghjklmnpqrstvwxyz]e$/.test(word)) word = word.slice(0, -1);
    var out = "";
    var i = 0;
    var afterConsonant = false;
    var lastVowel = "";
    while (i < word.length) {
      var ch = word.charAt(i);
      if (ch === "x") { word = word.slice(0, i) + "ks" + word.slice(i + 1); continue; }
      var v = null;
      for (var a = 0; a < VOWELS.length && !v; a++) if (startsWith(word, i, VOWELS[a][0])) v = VOWELS[a];
      if (v) {
        if (!afterConsonant && lastVowel) {
          // Two vowels side by side (India, Petroleum): a soft y or v joins them.
          out += (/[ie]$/.test(lastVowel) ? "య" : "వ") + v[2];
        } else {
          out += afterConsonant ? v[2] : v[1];
        }
        i += v[0].length;
        afterConsonant = false;
        lastVowel = v[0];
        continue;
      }
      lastVowel = "";
      var c = null;
      for (var b = 0; b < CONSONANTS.length && !c; b++) if (startsWith(word, i, CONSONANTS[b][0])) c = CONSONANTS[b];
      if (!c) {
        out += ch;
        i++;
        afterConsonant = false;
        continue;
      }
      var rest = word.slice(i + c[0].length);
      var nextIsVowel = /^[aeiou]/.test(rest);
      // n before k/g/c/j/t/d, m before p/b, and m at the end: anusvara (Ganga, Kumpa, Palem).
      var nasal = (c[0] === "n" && /^[kgcjtd]/.test(rest)) || (c[0] === "m" && (/^[pb]/.test(rest) || rest.length === 0));
      if (nasal && !afterConsonant && out) {
        out += ANUSVARA;
        i += c[0].length;
        continue;
      }
      if (afterConsonant) out += VIRAMA; // two consonants together: join them
      out += c[1];
      i += c[0].length;
      afterConsonant = true;
    }
    if (afterConsonant) out += VIRAMA;
    return out;
  }

  /** One word (any case) to Telugu. */
  function word(w) {
    var lower = w.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(WORDS, lower)) return WORDS[lower];
    if (/^[a-z]$/i.test(w)) return LETTERS[lower];
    // All-capital abbreviations without a vowel after the first letter: spell
    // them out (NCS, SVC, APSRTC). A zero-width non-joiner keeps the letters apart.
    if (/^[A-Z]{2,4}$/.test(w) || (/^[A-Z]{5,7}$/.test(w) && !/[AEIOU]/.test(w.slice(1)))) {
      return w.toLowerCase().split("").map(function (l) { return LETTERS[l]; }).join("‌");
    }
    return phonetic(lower);
  }

  /**
   * A full name to Telugu. Words keep their punctuation; text already in
   * Telugu (or any non-Latin script) is left as it is.
   */
  function toTelugu(name) {
    if (!name) return name;
    var trimmed = String(name).trim();
    var known = NAMES[trimmed.toLowerCase()];
    if (known) return known;
    var core = /^(.*?)(\s*\((?:near|#).*\))?$/.exec(trimmed); // keep "(near X)" handled separately
    var main = core[1];
    var tail = core[2] || "";
    var out = main.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, function (w) {
      var plain = w.replace(/'s$/i, "").replace(/'/g, "");
      var knownWord = NAMES[plain.toLowerCase()];
      return knownWord || word(plain);
    }).replace(/\s{2,}/g, " ").trim();
    if (tail) {
      tail = tail.replace(/\(near (.*)\)/i, function (m, inner) { return "(" + toTelugu(inner) + " దగ్గర)"; });
    }
    return tail ? out + " " + tail.trim() : out;
  }

  return { toTelugu: toTelugu, phonetic: phonetic, NAMES: NAMES, WORDS: WORDS };
});
