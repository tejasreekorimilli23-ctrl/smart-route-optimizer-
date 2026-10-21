/*
 * Firebase settings for shared community reports, official alerts and
 * anonymous trip speeds. Leave empty to keep reports on this device only.
 *
 * How to fill this in (about 10 minutes, free):
 *  1. Go to https://console.firebase.google.com/ and create a project.
 *  2. Build > Firestore Database > Create database (production mode, region
 *     asia-south1 Mumbai). Then Rules: paste the contents of firestore.rules
 *     from this project and Publish.
 *  3. Build > Authentication > Get started > Email/Password > Enable. Add a
 *     user for each admin (police / municipality / your team).
 *  4. For each admin: copy their User UID, then in Firestore create the
 *     document admins/<that UID> (any field, e.g. name: "Traffic police").
 *  5. Project settings (gear) > General > Your apps > Web app (</>): copy
 *     apiKey and projectId into the object below.
 *
 * The web apiKey is not a secret: Firebase web apps always include it. What
 * protects the data is firestore.rules.
 */
(function (root) {
  "use strict";
  root.FIREBASE_CONFIG = {
    apiKey: "AIzaSyCYPMaR6vqeO2u21aHVM9LcAHkxBrr4PWQ",
    projectId: "smarttrafficoptimizer"
  };
})(typeof self !== "undefined" ? self : this);
