/*
 * User accounts (optional): sign up, sign in, sign out, reset password,
 * and keep the user's own data (saved places, recent destinations, trip
 * history) in their account so it follows them to other devices.
 *
 * Uses Firebase Authentication (email + password) and Cloud Firestore
 * through their REST APIs, with the project in js/firebase-config.js.
 * Everything in the app works without an account; without Firebase
 * settings, accounts are simply not offered.
 *
 * Requirements in the Firebase console (see firestore.rules):
 *  - Authentication > Sign-in method > Email/Password: enabled;
 *  - the users/{uid} rule from firestore.rules published.
 *
 * Privacy: only the user's own document users/<their id> is read or
 * written, and the rules allow nobody else to read it. The session (tokens)
 * is kept in this browser's localStorage, as Firebase's own SDK does.
 *
 * Exposes window.Accounts; also works in Node (tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Accounts = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SESSION_KEY = "account-session";
  var TIMEOUT_MS = 15000;

  // Firebase error names -> codes the app translates.
  var ERRORS = {
    EMAIL_EXISTS: "exists",
    EMAIL_NOT_FOUND: "wrong",
    INVALID_PASSWORD: "wrong",
    INVALID_LOGIN_CREDENTIALS: "wrong",
    INVALID_EMAIL: "email",
    MISSING_EMAIL: "email",
    MISSING_PASSWORD: "password",
    WEAK_PASSWORD: "weak",
    USER_DISABLED: "disabled",
    TOO_MANY_ATTEMPTS_TRY_LATER: "toomany",
    OPERATION_NOT_ALLOWED: "notenabled",
    PERMISSION_DENIED: "rules"
  };

  function failure(code, detail) {
    var err = new Error("Accounts: " + code + (detail ? " (" + detail + ")" : ""));
    err.code = code;
    return err;
  }

  function codeFor(message) {
    var m = String(message || "").split(/[ :]/)[0];
    return ERRORS[m] || "failed";
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
  }

  /**
   * config: { apiKey, projectId }; storage: localStorage-like; fetchImpl
   * optional. Returns the account API, or null without a config.
   */
  function create(config, storage, fetchImpl) {
    if (!config || !config.apiKey || !config.projectId) return null;
    var doFetch = fetchImpl || (typeof fetch === "function" ? function (u, o) { return fetch(u, o); } : null);
    var key = "key=" + encodeURIComponent(config.apiKey);
    var AUTH = "https://identitytoolkit.googleapis.com/v1/accounts:";
    var TOKEN = "https://securetoken.googleapis.com/v1/token?" + key;
    var DOCS = "https://firestore.googleapis.com/v1/projects/" + config.projectId + "/databases/(default)/documents/";
    var session = null;
    try { session = JSON.parse(storage.getItem(SESSION_KEY) || "null"); } catch (err) { session = null; }

    function save(s) {
      session = s;
      try {
        if (s) storage.setItem(SESSION_KEY, JSON.stringify(s));
        else storage.removeItem(SESSION_KEY);
      } catch (err) { /* private mode: the session lasts until the page closes */ }
    }

    function call(url, options) {
      var req;
      try {
        req = Promise.resolve(doFetch(url, options));
      } catch (err) {
        req = Promise.reject(err);
      }
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(failure("offline")); }, TIMEOUT_MS);
        req.then(function (res) {
          clearTimeout(timer);
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (res.ok) return resolve(body);
            var msg = body && body.error && (body.error.message || body.error.status);
            if (res.status === 403 && !ERRORS[String(msg).split(/[ :]/)[0]]) return reject(failure("rules", msg));
            if (res.status === 404) return resolve(null); // no document yet
            reject(failure(codeFor(msg), msg));
          });
        }, function () {
          clearTimeout(timer);
          reject(failure("offline"));
        });
      });
    }

    function post(url, body, form) {
      return call(url, {
        method: "POST",
        headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? body : JSON.stringify(body)
      });
    }

    function fromAuth(r) {
      return {
        uid: r.localId || r.user_id,
        email: r.email,
        idToken: r.idToken || r.id_token,
        refreshToken: r.refreshToken || r.refresh_token,
        expiresAt: Date.now() + (Number(r.expiresIn || r.expires_in || 3600) - 60) * 1000
      };
    }

    function check(email, password) {
      if (!validEmail(email)) return Promise.reject(failure("email"));
      if (!password || String(password).length < 6) return Promise.reject(failure("weak"));
      return null;
    }

    /** A fresh ID token for the signed-in user (refreshed when it expired). */
    function token() {
      if (!session) return Promise.reject(failure("signedout"));
      if (session.expiresAt > Date.now()) return Promise.resolve(session.idToken);
      return post(TOKEN, "grant_type=refresh_token&refresh_token=" + encodeURIComponent(session.refreshToken), true).then(function (r) {
        var s = fromAuth(r);
        s.email = session.email;
        save(s);
        return s.idToken;
      }, function (err) {
        if (err.code !== "offline") save(null); // the session is no longer valid
        throw err;
      });
    }

    return {
      current: function () { return session ? { uid: session.uid, email: session.email } : null; },

      signUp: function (email, password) {
        return check(email, password) || post(AUTH + "signUp?" + key, { email: email, password: password, returnSecureToken: true })
          .then(function (r) { save(fromAuth(r)); return { uid: session.uid, email: session.email }; });
      },

      signIn: function (email, password) {
        if (!validEmail(email)) return Promise.reject(failure("email"));
        if (!password) return Promise.reject(failure("password"));
        return post(AUTH + "signInWithPassword?" + key, { email: email, password: password, returnSecureToken: true })
          .then(function (r) { save(fromAuth(r)); return { uid: session.uid, email: session.email }; });
      },

      signOut: function () { save(null); },

      /** Sends Firebase's password-reset email. */
      resetPassword: function (email) {
        if (!validEmail(email)) return Promise.reject(failure("email"));
        return post(AUTH + "sendOobCode?" + key, { requestType: "PASSWORD_RESET", email: email }).then(function () { return true; });
      },

      /** The user's stored data ({} when there is none yet). */
      load: function () {
        return token().then(function (t) {
          return call(DOCS + "users/" + encodeURIComponent(session.uid), { headers: { Authorization: "Bearer " + t } });
        }).then(function (doc) {
          var text = doc && doc.fields && doc.fields.data && doc.fields.data.stringValue;
          try { return text ? JSON.parse(text) : {}; } catch (err) { return {}; }
        });
      },

      /** Replaces the user's stored data with obj (saved places, recents, trips). */
      store: function (obj) {
        return token().then(function (t) {
          var url = DOCS + "users/" + encodeURIComponent(session.uid) + "?updateMask.fieldPaths=data&updateMask.fieldPaths=updatedAt";
          return call(url, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
            body: JSON.stringify({ fields: { data: { stringValue: JSON.stringify(obj) }, updatedAt: { timestampValue: new Date().toISOString() } } })
          });
        }).then(function () { return true; });
      }
    };
  }

  return { create: create, validEmail: validEmail, ERRORS: ERRORS, SESSION_KEY: SESSION_KEY };
});
