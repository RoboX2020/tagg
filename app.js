// ============================================================================
// Tagg - people memory with a personal agent. Client-side MVP.
//
// What it does: you carry a digital card (name + links) as a QR code. Someone
// scans it with any phone camera - no app install - and saves your card. Tagg
// remembers WHEN and WHERE you met, keeps your private notes per person, and
// later answers questions like "who did I meet at Cal Hacks who works on
// robotics?" Everything is one static page: data lives in localStorage, the
// card travels INSIDE the QR link itself (base64 in the URL), and an optional
// Cloudflare Worker API syncs across devices when signed in.
// ============================================================================
(function () {
  "use strict";

  /* ================= storage ================= */
  var LS_CARD = "tagg.card.v1";
  var LS_PEOPLE = "tagg.people.v1";

  function loadCard() {
    try { return JSON.parse(localStorage.getItem(LS_CARD) || "null"); } catch (e) { return null; }
  }
  function saveCard(c) { localStorage.setItem(LS_CARD, JSON.stringify(c)); }
  function loadPeople() {
    try { return JSON.parse(localStorage.getItem(LS_PEOPLE) || "[]"); } catch (e) { return []; }
  }
  function savePeople(p) { localStorage.setItem(LS_PEOPLE, JSON.stringify(p)); }
  function uid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  /* ================= tagg cloud database ================= */
  // The API address can be overridden for local testing: localStorage.setItem("tagg.api", "http://localhost:8787")
  var API = localStorage.getItem("tagg.api") || "https://tagg-api.prajval-2029.workers.dev";
  function ownerToken() { return localStorage.getItem("tagg.owner.v1") || null; }
  function setOwnerToken(t) { if (t) localStorage.setItem("tagg.owner.v1", t); }
  function cardSlug() { return localStorage.getItem("tagg.slug.v1") || null; }
  function setCardSlug(v) { if (v) localStorage.setItem("tagg.slug.v1", v); }
  function api(path, opts) {
    opts = opts || {};
    var h = { "Content-Type": "application/json" };
    var t = ownerToken();
    if (t) h.Authorization = "Bearer " + t;
    return fetch(API + path, { method: opts.method || "GET", headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw (d || {}); return d; }); });
  }
  function ensureOwner() {
    if (ownerToken()) return Promise.resolve(ownerToken());
    return api("/api/owner", { method: "POST", body: {} }).then(function (d) { setOwnerToken(d.ownerToken); return d.ownerToken; });
  }
  function syncCard() {
    var c = loadCard(); if (!c) return Promise.resolve(null);
    return ensureOwner().then(function () {
      return api("/api/card", { method: "POST", body: { ownerToken: ownerToken(), card: c } });
    }).then(function (d) { setCardSlug(d.slug); return d; }).catch(function () { return null; });
  }
  function migrateOnce() {
    if (localStorage.getItem("tagg.migrated.v1")) return Promise.resolve();
    var locals = loadPeople();
    localStorage.setItem("tagg.migrated.v1", "1");
    if (!locals.length || !ownerToken()) return Promise.resolve();
    return api("/api/migrate", { method: "POST", body: { ownerToken: ownerToken(), people: locals } }).catch(function () {});
  }
  function syncPeople() {
    if (!ownerToken()) return Promise.resolve(loadPeople());
    return api("/api/people").then(function (d) {
      var list = d.people || [];
      savePeople(list);
      return list;
    }).catch(function () { return loadPeople(); });
  }
  var GOOGLE_CLIENT_ID = "234788686355-ah0fsgjc8cr8n2h1f9oi0ielbket64jf.apps.googleusercontent.com";
  function profile() { try { return JSON.parse(localStorage.getItem("tagg.profile.v1") || "null"); } catch (e) { return null; } }
  function setProfile(p) { if (p) localStorage.setItem("tagg.profile.v1", JSON.stringify(p)); else localStorage.removeItem("tagg.profile.v1"); }
  // Runs after ANY successful sign-in (Google or email): remember who you are,
  // pull your card and people onto this device. "quiet" skips the screen refresh
  // so the scan page keeps its form while the connection is being sent.
  function afterAuth(d, quiet) {
    setOwnerToken(d.ownerToken);
    setProfile(d.profile);
    lastSync = 0;
    var restore = Promise.resolve();
    if (!loadCard()) {
      restore = api("/api/me").then(function (me) {
        if (me && me.slug) return api("/api/c/" + me.slug).then(function (cd) {
          if (cd && cd.card) { saveCard(cd.card); setCardSlug(me.slug); }
        });
      }).catch(function () {});
    }
    return restore.then(function () { return syncPeople(); }).then(function () {
      if (!quiet) { toast("Signed in as " + (d.profile.email || "you") + " - your Tagg is backed up"); route(); }
    });
  }
  // Google sign-in: the browser hands us a signed token, the server verifies it.
  function googleSignIn(credential, onDone) {
    return api("/api/auth/google", { method: "POST", body: { credential: credential, deviceToken: ownerToken() } })
      .then(function (d) { return afterAuth(d, !!onDone).then(function () { if (onDone) onDone(d); }); })
      .catch(function () { toast("Sign-in failed - your data is still safe on this device"); });
  }
  // Email + password: mode is "signup" or "login". Rejects with a readable message.
  function emailAuth(mode, name, email, password) {
    var body = { email: email, password: password, deviceToken: ownerToken() };
    if (mode === "signup") body.name = name;
    return api("/api/auth/" + mode, { method: "POST", body: body }).then(function (d) {
      return afterAuth(d, true).then(function () { return d; });
    });
  }
  // Shown once after sign-up or a password reset. Tagg cannot email you, so this code is the only
  // way back in if the password is forgotten. We store only a hash of it.

  // Email verification: ask the server to email a 6-digit code, then confirm it. Disabled server-side until a sender is set up.
  function showVerifyEmail() {
    var bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet"><div class="grab"></div><h3>Verify your email</h3>' +
      '<p class="hint" id="ve-msg">We will email a 6-digit code to ' + esc((profile() || {}).email || "you") + '. It expires in 15 minutes.</p>' +
      '<input class="input" id="ve-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="display:none">' +
      '<div style="height:12px"></div><button class="btn btn-accent" id="ve-go">Send code</button>' +
      '<button class="btn btn-gray" id="ve-close">Close</button></div>';
    document.body.appendChild(bg);
    var msg = bg.querySelector("#ve-msg"), code = bg.querySelector("#ve-code"), go = bg.querySelector("#ve-go"), sent = false;
    bg.querySelector("#ve-close").addEventListener("click", function () { bg.remove(); });
    go.addEventListener("click", function () {
      go.disabled = true;
      var req = sent ? api("/api/auth/email/confirm", { method: "POST", body: { code: code.value.trim() } })
                     : api("/api/auth/email/request", { method: "POST", body: {} });
      req.then(function (d) {
        go.disabled = false;
        if (d.verified) { var p = profile() || {}; p.emailVerified = true; setProfile(p); bg.remove(); toast("Email verified"); route(); return; }
        sent = true; code.style.display = ""; code.focus(); go.textContent = "Confirm"; msg.textContent = "Code sent. Enter it below.";
      }).catch(function (e) { go.disabled = false; msg.textContent = (e && e.error) || "Something went wrong"; });
    });
  }

  // Delete account: confirm with the word DELETE (and the password for email accounts). Clears this device too.
  function showDeleteAccount() {
    var isEmail = (profile() || {}).kind === "email";
    var bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet"><div class="grab"></div><h3>Delete your account</h3>' +
      '<p class="hint" id="da-msg">This permanently deletes your card, your saved people, your notes, photos and locations, and your sign-in. It does not remove the copy of your card that other people already saved, and it cannot be undone.</p>' +
      (isEmail ? '<input class="input" id="da-pass" style="margin-bottom:10px" type="password" placeholder="Password" autocomplete="current-password">'
        : '<p class="hint" id="da-gmsg">Confirm it is you: sign in with Google again.</p><div id="da-g"></div>') +
      '<input class="input" id="da-word" placeholder="Type DELETE to confirm" autocapitalize="characters">' +
      '<p class="hint" id="da-err" style="color:var(--accent)"></p>' +
      '<div style="height:12px"></div><button class="btn btn-accent" id="da-go">Delete everything</button>' +
      '<button class="btn btn-gray" id="da-close">Cancel</button></div>';
    document.body.appendChild(bg);
    var msg = bg.querySelector("#da-msg"), gcred = null;
    if (!isEmail) mountGoogleButton(bg.querySelector("#da-g"), 0, null, function (c) { gcred = c; bg.querySelector("#da-gmsg").textContent = "Google confirmed. Type DELETE below to finish."; });
    bg.querySelector("#da-close").addEventListener("click", function () { bg.remove(); });
    bg.querySelector("#da-go").addEventListener("click", function () {
      var pw = bg.querySelector("#da-pass");
      api("/api/account", { method: "DELETE", body: { confirm: bg.querySelector("#da-word").value.trim(), password: pw ? pw.value : undefined, credential: gcred || undefined } })
        .then(function () {
          Object.keys(localStorage).filter(function (k) { return k.indexOf("tagg.") === 0 && k !== "tagg.api"; }).forEach(function (k) { localStorage.removeItem(k); });
          bg.remove(); toast("Account deleted"); location.hash = "#/"; route();
        }).catch(function (e) { bg.querySelector("#da-err").textContent = (e && e.error) || "Something went wrong"; });
    });
  }
  function showRecoveryCode(code, done) {
    var bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet"><div class="grab"></div><h3>Save your recovery code</h3>' +
      '<p class="hint">Tagg cannot send email yet, so this code is the only way to reset your password. It is shown once. Screenshot it or write it down.</p>' +
      '<div class="answer" style="font-family:ui-monospace,Menlo,monospace;font-size:20px;letter-spacing:.04em;text-align:center">' + esc(code) + '</div>' +
      '<div style="height:12px"></div><button class="btn btn-gray" id="rc-copy">Copy code</button>' +
      '<button class="btn btn-accent" id="rc-ok">I saved it</button></div>';
    document.body.appendChild(bg);
    bg.querySelector("#rc-copy").addEventListener("click", function () {
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { toast("Copied"); }, function () { toast("Copy failed - screenshot it"); });
    });
    bg.querySelector("#rc-ok").addEventListener("click", function () { bg.remove(); done(); });
  }
  // The sign-up / sign-in block used on the home screen and on the scan page.
  // opts.mode = "signup" | "login"; opts.cta = button label; opts.onDone(d) runs after success.
  function mountAuthBlock(el, opts) {
    var mode = opts.mode || "signup";
    function draw() {
      var su = mode === "signup";
      el.innerHTML =
        '<div id="gbtn" style="display:flex;justify-content:center;margin-bottom:6px"></div>' +
        '<p class="hint" style="text-align:center;margin:8px 0">or use email</p>' +
        (su ? '<div class="field"><label>Your name</label><input class="input" id="au-name" autocomplete="name" placeholder="Your name"></div>' : '') +
        '<div class="field"><label>Email</label><input class="input" id="au-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
        '<div class="field"><label>Password' + (su ? ' <span style="text-transform:none;color:var(--text-3);font-weight:400">(8+ characters)</span>' : '') + '</label><input class="input" id="au-pass" type="password" autocomplete="' + (su ? 'new-password' : 'current-password') + '"></div>' +
        '<div style="height:12px"></div>' +
        '<button class="btn btn-accent" id="au-go">' + esc(su ? (opts.cta || "Create account") : "Sign in") + '</button>' +
        '<button class="btn btn-plain" id="au-switch">' + (su ? 'I already have an account' : 'Create a new account') + '</button>' +
        (su ? '' : '<button class="btn btn-plain" id="au-forgot" style="color:var(--text-2)">Forgot password? Use recovery code</button>');
      var fg = el.querySelector("#au-forgot");
      if (fg) fg.addEventListener("click", function () { drawReset(); });
      mountGoogleButton(el.querySelector("#gbtn"), 0, function (d) { if (opts.onDone) opts.onDone(d); else route(); });
      el.querySelector("#au-switch").addEventListener("click", function () { mode = su ? "login" : "signup"; draw(); });
      el.querySelector("#au-go").addEventListener("click", function () {
        var btn = this;
        var name = su ? el.querySelector("#au-name").value.trim() : "";
        var email = el.querySelector("#au-email").value.trim();
        var pw = el.querySelector("#au-pass").value;
        if (su && !name) { toast("Add your name first"); return; }
        if (!email || !pw) { toast("Enter your email and password"); return; }
        var label = btn.textContent; btn.disabled = true; btn.textContent = "One moment...";
        emailAuth(mode, name, email, pw).then(function (d) {
          function finish() { if (opts.onDone) opts.onDone(d, name); else { toast("Signed in as " + email); route(); } }
          if (d.recoveryCode) showRecoveryCode(d.recoveryCode, finish); else finish();
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = label;
          toast((e && e.error) || "Could not reach the server - try again");
        });
      });
    }
    // Reset the password with the recovery code from sign-up (a new code is issued).
    function drawReset() {
      el.innerHTML =
        '<div class="field"><label>Email</label><input class="input" id="rs-email" type="email" autocomplete="email"></div>' +
        '<div class="field"><label>Recovery code</label><input class="input" id="rs-code" placeholder="xxxxx-xxxxx-xxxxx-xxxxx" autocapitalize="off"></div>' +
        '<div class="field"><label>New password</label><input class="input" id="rs-pass" type="password" autocomplete="new-password"></div>' +
        '<div style="height:12px"></div><button class="btn btn-accent" id="rs-go">Reset password</button>' +
        '<button class="btn btn-plain" id="rs-back">Back</button>';
      el.querySelector("#rs-back").addEventListener("click", function () { mode = "login"; draw(); });
      el.querySelector("#rs-go").addEventListener("click", function () {
        var btn = this; btn.disabled = true;
        api("/api/auth/reset", { method: "POST", body: { email: el.querySelector("#rs-email").value.trim(), recoveryCode: el.querySelector("#rs-code").value.trim(), newPassword: el.querySelector("#rs-pass").value } })
          .then(function (d) { return afterAuth(d, true).then(function () { showRecoveryCode(d.recoveryCode, function () { if (opts.onDone) opts.onDone(d); else { toast("Password reset"); route(); } }); }); })
          .catch(function (e) { btn.disabled = false; toast((e && e.error) || "Could not reach the server"); });
      });
    }
    draw();
  }
  function mountGoogleButton(el, tries, onDone, onCredential) {
    if (!window.google || !google.accounts || !google.accounts.id) {
      tries = tries || 0;
      if (tries < 25) { setTimeout(function () { mountGoogleButton(el, tries + 1, onDone, onCredential); }, 400); return; }
      el.innerHTML = '<p class="hint">Google sign-in could not load - check your connection.</p>'; return;
    }
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: function (resp) { if (onCredential) onCredential(resp.credential); else googleSignIn(resp.credential, onDone); } });
    google.accounts.id.renderButton(el, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 300 });
  }
  var lastSync = 0, syncing = false, INBOX = [], INBOX_COUNT = 0, SCANS = [];
  function refreshSoon(force) {
    if (syncing || (!force && Date.now() - lastSync < 10000)) return;
    syncing = true; lastSync = Date.now();
    syncPeople().then(function () {
      if (!ownerToken()) return;
      return api("/api/inbox").then(function (d) {
        INBOX = d.requests || []; INBOX_COUNT = INBOX.length; SCANS = d.scans || [];
      }).catch(function () {});
    }).then(function () { syncing = false; route(); }, function () { syncing = false; });
  }
  // Live view for the card owner: while the home screen is open, check for scans and requests every 4 seconds
  // and redraw only when something changed. A scan is anonymous: it says "someone", never who.
  var livePoll = null, liveSig = "", liveFails = 0;
  function scanBannerHtml() {
    if (!SCANS.length) return "";
    var n = SCANS.length;
    // We cannot tell a QR scan from a link preview or a bot, so this only claims the card was opened.
    return '<div class="scanbanner" id="scanbanner"><span class="dot"></span><span>' + (n === 1 ? "Your card was just opened." : "Your card was opened " + n + " times in the last few minutes.") +
      ' <span style="color:var(--text-2)">Anonymous. It could be a scan or a link preview. Waiting to see if they share details.</span></span></div>';
  }
  // Polls only while the owner's home screen is visible and signed in: stops on leaving the screen or hiding the tab,
  // resumes on return, and backs off (4 s up to 60 s) after failures.
  function liveWanted() { var h = location.hash || "#/"; return !!ownerToken() && (h === "#/" || h === "") && !document.hidden; }
  function stopLive() { if (livePoll) { clearTimeout(livePoll); livePoll = null; } }
  function startLive() {
    if (livePoll || !liveWanted()) return;
    function tick() {
      livePoll = null;
      if (!liveWanted()) return;                       // left the screen: stop, no timer left behind
      if (document.querySelector(".sheet-bg") || syncing) { livePoll = setTimeout(tick, 4000); return; }
      api("/api/inbox").then(function (d) {
        liveFails = 0;
        var sig = (d.scans || []).map(function (x) { return x.id; }).join() + "|" + (d.requests || []).map(function (x) { return x.id; }).join();
        if (sig !== liveSig) {
          liveSig = sig;
          INBOX = d.requests || []; INBOX_COUNT = INBOX.length; SCANS = d.scans || [];
          if (liveWanted() && !document.querySelector(".sheet-bg")) { lastSync = 0; refreshSoon(true); }
        }
      }).catch(function () { liveFails++; }).then(function () {
        if (liveWanted()) livePoll = setTimeout(tick, Math.min(60000, 4000 * Math.pow(2, Math.min(liveFails, 4))));
      });
    }
    livePoll = setTimeout(tick, 4000);
  }
  window.addEventListener("hashchange", function () { stopLive(); startLive(); });
  document.addEventListener("visibilitychange", function () { stopLive(); startLive(); });
  // One-time disclosure sheet. Remembers the answer per feature, so it asks once, before the first action.
  function consentThen(key, title, body, label, go) {
    if (localStorage.getItem("tagg.consent." + key)) return go();
    var bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet"><div class="grab"></div><h3>' + esc(title) + '</h3>' +
      '<p class="hint">' + body + '</p>' +
      '<button class="btn btn-accent" id="c-yes">' + esc(label) + '</button>' +
      '<button class="btn btn-plain" id="c-no">Not now</button></div>';
    document.body.appendChild(bg);
    bg.querySelector("#c-no").addEventListener("click", function () { bg.remove(); });
    bg.querySelector("#c-yes").addEventListener("click", function () { localStorage.setItem("tagg.consent." + key, "1"); bg.remove(); go(); });
  }
  /* location with a human-readable place label */
  // Ask the browser for the user's location (to record WHERE a meeting
  // happened), then look up the nearest city name. Fully optional: any failure
  // or refusal quietly calls back with null and the app moves on - the total
  // wait is capped at 4.5 s so a slow GPS fix never hangs the flow.
  // Location, in two independent steps so a slow or failed place lookup never loses the coordinates:
  //  1. the device position (permission prompt, up to 20 s, high accuracy), 2. the nearest place name (own 5 s limit).
  // locate() returns a promise of {ok, loc, reason}. reason: denied | unavailable | timeout | unsupported | insecure.
  // onStatus(kind, loc) is called as it goes so the page can show what is happening.
  function locate(onStatus) {
    onStatus = onStatus || function () {};
    return new Promise(function (resolve) {
      if (!window.isSecureContext) { onStatus("insecure"); return resolve({ ok: false, reason: "insecure" }); }
      if (!navigator.geolocation) { onStatus("unsupported"); return resolve({ ok: false, reason: "unsupported" }); }
      onStatus("asking");
      navigator.geolocation.getCurrentPosition(function (pos) {
        // 5 decimals is about 1 meter: enough for "where we met" without storing a needlessly exact trail.
        var loc = { lat: +pos.coords.latitude.toFixed(5), lon: +pos.coords.longitude.toFixed(5), label: "", place: "" };
        // Keep what the device reported: accuracy radius in meters and when the fix was taken (5 decimals is only the stored precision, not the accuracy).
        if (typeof pos.coords.accuracy === "number" && isFinite(pos.coords.accuracy)) loc.acc = Math.round(pos.coords.accuracy);
        if (pos.timestamp) loc.at = new Date(pos.timestamp).toISOString();
        onStatus("found", loc);
        var ctl = window.AbortController ? new AbortController() : null;
        var t = setTimeout(function () { if (ctl) ctl.abort(); finish(); }, 5000);
        var finished = false;
        function finish() { if (finished) return; finished = true; clearTimeout(t); onStatus("named", loc); resolve({ ok: true, loc: loc }); }
        // Free OpenStreetMap Nominatim reverse lookup; zoom 18 gives the nearest venue, building or street.
        fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=" + loc.lat + "&lon=" + loc.lon, ctl ? { signal: ctl.signal } : undefined)
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var a = d.address || {};
            loc.place = d.name || a.amenity || a.building || a.tourism || a.leisure || a.shop || a.road || "";
            loc.label = [a.city || a.town || a.village || a.suburb || a.county || "", a.state || ""].filter(Boolean).join(", ") || (d.display_name || "").split(",").slice(0, 2).join(",");
            finish();
          }).catch(finish);
      }, function (err) {
        var reason = err && err.code === 1 ? "denied" : err && err.code === 3 ? "timeout" : "unavailable";
        onStatus(reason); resolve({ ok: false, reason: reason });
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
    });
  }
  function withLocation(cb) { locate().then(function (r) { cb(r.ok ? r.loc : null); }); }
  function fixNote(loc) {
    if (!loc || loc.lat == null) return "";
    var parts = [];
    if (typeof loc.acc === "number") parts.push("GPS fix, accurate to about " + (loc.acc >= 1000 ? (loc.acc / 1000).toFixed(1) + " km" : loc.acc + " m"));
    if (loc.at) { var d = new Date(loc.at); if (!isNaN(d)) parts.push(d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })); }
    return parts.join(" at ");
  }
  function mapsUrl(loc) { return "https://www.google.com/maps/search/?api=1&query=" + loc.lat + "%2C" + loc.lon; }
  function locStatusHtml(kind, loc) {
    var retry = ' <a href="#" data-locretry="1">Try again</a>';
    if (kind === "asking") return "Finding your location. Allow access if your phone asks.";
    if (kind === "found" || kind === "named") {
      var nm = loc && [loc.place, loc.label].filter(Boolean).join(", ");
      return "Location ready" + (nm ? ": " + esc(nm) : (kind === "found" ? ". Looking up the place name..." : ". Place name not available, the pin is saved.")) +
        '<br><a href="' + mapsUrl(loc) + '" target="_blank" rel="noopener">Open in Google Maps</a> <span style="color:var(--text-3)">(' + loc.lat + ", " + loc.lon + ")</span>" + (fixNote(loc) ? '<br><span style="color:var(--text-3)">' + esc(fixNote(loc)) + "</span>" : "");
    }
    if (kind === "denied") return "Location is blocked for this site. On iPhone: Settings, Privacy and Security, Location Services, Safari Websites, set to While Using. Then" + retry + "." ;
    if (kind === "timeout") return "Could not get a location fix in time. Move near a window if you are indoors." + retry;
    if (kind === "insecure") return "Location needs a secure (https) page.";
    if (kind === "unsupported") return "This browser does not support location.";
    return "Location is unavailable right now." + retry;
  }

  /* ================= card payload (QR) ================= */
  // THE core trick of Tagg: the whole card is packed INTO the link, so a
  // stranger's phone can read it with zero servers and zero sign-in.
  function cardUrl(c) {
    // Signed-in users get a short link (#/c/<slug>) served by the API instead -
    // much shorter, which makes a less dense, easier-to-scan QR code.
    var slug = cardSlug();
    if (slug) return location.origin + location.pathname + "#/c/" + slug;
    // Offline/self-contained mode: build a compact JSON payload with one-letter
    // keys (n = name, h = headline, e = email, p = phone, l = links) to keep
    // the URL - and therefore the QR pattern - as small as possible.
    var payload = { v: 1, n: c.name, h: c.headline || "" };
    if (c.email) payload.e = c.email;
    if (c.phone) payload.p = c.phone;
    var l = {};
    ["linkedin", "github", "x", "instagram", "website"].forEach(function (k) {
      if (c.links && c.links[k]) l[k] = c.links[k];
    });
    if (Object.keys(l).length) payload.l = l;
    var json = JSON.stringify(payload);
    // Base64-encode the JSON (btoa), handling non-English characters safely via
    // the encodeURIComponent/unescape dance (plain btoa chokes on Unicode).
    // Then make it URL-safe: + and / are awkward in links, so swap to - and _,
    // and drop the trailing = padding (decodePayload restores it).
    var b64 = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return location.origin + location.pathname + "#/c/" + b64;
  }
  // The inverse of cardUrl's packing: undo the URL-safe alphabet, restore the
  // = padding to a multiple of 4, decode, and map the one-letter keys back to
  // real field names. Returns null on anything malformed.
  function decodePayload(b64) {
    try {
      var s = b64.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      var obj = JSON.parse(decodeURIComponent(escape(atob(s))));
      if (!obj || !obj.n) return null;
      return {
        name: obj.n, headline: obj.h || "", email: obj.e || "", phone: obj.p || "",
        links: obj.l || {}
      };
    } catch (e) { return null; }
  }

  /* ================= helpers ================= */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function initial(name) { return (name || "?").trim().charAt(0).toUpperCase(); }
  function fmtDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2200);
  }
  var LINK_DEFS = [
    ["linkedin", "LinkedIn"], ["github", "GitHub"], ["x", "X"],
    ["instagram", "Instagram"], ["website", "Website"]
  ];
  function normUrl(k, v) {
    v = (v || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    v = v.replace(/^@/, "");
    if (/^(www\.)?(linkedin\.com|github\.com|x\.com|twitter\.com|instagram\.com)\//i.test(v)) return "https://" + v;
    var hosts = { linkedin: "linkedin.com/in/", github: "github.com/", x: "x.com/", instagram: "instagram.com/" };
    if (k === "website") return "https://" + v.replace(/^https?:\/\//, "");
    return "https://" + (hosts[k] || "") + v;
  }
  function chipsHtml(c) {
    var out = "";
    LINK_DEFS.forEach(function (kd) {
      var u = c.links && c.links[kd[0]];
      if (u) out += '<a class="chip" href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(kd[1]) + '</a>';
    });
    if (c.email) out += '<a class="chip" href="mailto:' + esc(c.email) + '">Email</a>';
    if (c.phone) out += '<a class="chip" href="tel:' + esc(c.phone) + '">Call</a>';
    return out;
  }
  function cardHtml(c) {
    return '<div class="taggcard">' +
      '<div class="tc-mark">Tagg</div>' +
      '<div class="tc-name">' + esc(c.name) + '</div>' +
      (c.headline ? '<div class="tc-head">' + esc(c.headline) + '</div>' : '') +
      '<div class="tc-links">' + chipsHtml(c) + '</div>' +
      '</div>';
  }

  /* vCard export - "Save to Contacts" */
  function vcfText(p) {
    var c = p.card;
    function escV(v) { return String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
    var parts = c.name.trim().split(/\s+/);
    var last = parts.length > 1 ? parts[parts.length - 1] : "";
    var first = (parts.length > 1 ? parts.slice(0, -1).join(" ") : c.name.trim());
    var lines = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Tagg//EN"];
    lines.push("N:" + escV(last) + ";" + escV(first) + ";;;");
    lines.push("FN:" + escV(c.name.trim()));
    if (c.headline) lines.push("TITLE:" + escV(c.headline));
    if (c.email) lines.push("EMAIL;TYPE=INTERNET:" + escV(c.email));
    if (c.phone) lines.push("TEL;TYPE=CELL:" + escV(c.phone));
    LINK_DEFS.forEach(function (kd) {
      var u = c.links && c.links[kd[0]];
      if (u) lines.push("URL;TYPE=" + kd[1] + ":" + u);
    });
    var note = "Met " + fmtDate(p.metAt) + " at " + fmtTime(p.metAt) +
      (p.event ? " - " + p.event : "") + " via Tagg." + (p.note ? " " + p.note : "");
    lines.push("NOTE:" + escV(note));
    lines.push("END:VCARD");
    return lines.join("\r\n");
  }
  function downloadVcf(p) {
    var blob = new Blob([vcfText(p)], { type: "text/vcard;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = p.card.name.trim().replace(/\s+/g, "-") + ".vcf";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 500);
    toast("Contact card downloaded - open it to add " + p.card.name.split(" ")[0]);
  }

  /* "why you two might be worth talking to" - keyword overlap heuristic */
  var BUCKETS = [
    [/robot|ros|sim|isaac|mechanic|hardware|embedded|drone|actuator/i, "robotics"],
    [/\bai\b|ml|machine learning|llm|model|vision|neural|agent/i, "AI"],
    [/design|ui|ux|product/i, "product and design"],
    [/founder|startup|venture|cto|ceo/i, "startups"],
    [/web|frontend|backend|full.?stack|software|swe|code|engineer/i, "software"],
    [/research|phd|paper|lab/i, "research"],
    [/student|asu|university|college/i, "student life"]
  ];
  function topicsOf(text) {
    var t = [];
    BUCKETS.forEach(function (b) { if (b[0].test(text || "")) t.push(b[1]); });
    return t;
  }
  // Compose one plain sentence explaining why this contact matters to YOU:
  // shared topic if you overlap, their topic if not, or a gentle nudge to add
  // a note when nothing is known yet.
  function whyTalk(me, them, eventName) {
    var mine = topicsOf((me && me.headline) || "");
    var theirs = topicsOf((them.headline || "") + " " + (them.name || ""));
    var overlap = theirs.filter(function (t) { return mine.indexOf(t) >= 0; });
    if (overlap.length) {
      return "You both work on " + overlap.join(" and ") + ". Worth a follow-up while " +
        (eventName ? eventName + " is still fresh." : "the conversation is still fresh.");
    }
    if (theirs.length) {
      return "Their world is " + theirs.join(" and ") + (eventName ? " - a good contact from " + eventName + "." : ".");
    }
    return eventName ? "A good contact from " + eventName + " - add a note about what you discussed." : "Add a note about what you discussed.";
  }

  /* ================= icons (inline SVG) ================= */
  var IC = {
    card: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16.5c.7-1.6 2-2.4 3.5-2.4s2.8.8 3.5 2.4"/><path d="M15 10h4M15 13.5h4"/></svg>',
    people: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3 2.9-4.6 5.5-4.6s4.7 1.6 5.5 4.6"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.6c2.4.2 4 1.6 4.6 4"/></svg>',
    ask: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a8 8 0 0 0-8 8c0 2.1.8 4 2.2 5.4L5 21l4.8-1.3c.7.2 1.4.3 2.2.3a8 8 0 0 0 0-16Z"/><path d="M9.6 10.2c.2-1.2 1.2-2 2.4-2 1.3 0 2.3.9 2.3 2 0 1.4-1.4 1.8-2.2 2.7-.1.2-.1.5-.1 1"/><circle cx="12" cy="15.6" r="0.4" fill="currentColor"/></svg>',
    map: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="2.6"/><circle cx="4.5" cy="6" r="1.8"/><circle cx="19.5" cy="5.5" r="1.8"/><circle cx="5" cy="18.5" r="1.8"/><circle cx="19" cy="18" r="1.8"/><path d="M6.2 7l3.6 3.2M17.8 6.6l-3.4 3.3M6.5 17.2l3.2-3M16.6 16.5l-2.6-2.4"/></svg>',
    settings: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
    qr: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z"/></svg>',
    mic: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    chev: '<svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
  };

  /* ================= routing ================= */
  var app = document.getElementById("app");
  function setTheme(t) {
    localStorage.setItem("tagg.theme", t === "dark" ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", t === "dark" ? "#0a0a0b" : "#f4f4f6");
  }
  function route() {
    var h = location.hash || "#/";
    window.scrollTo(0, 0);
    if (h.indexOf("#/c/") === 0) return renderScannedRoute(h.slice(4));
    if (h.indexOf("#/p/") === 0) return renderPerson(h.slice(4));
    if (h === "#/privacy") {
      shell(null, '<h1 class="largetitle">Privacy</h1>' +
        '<p class="lead">Tagg is a people memory. Here is exactly what it does with data.</p>' +
        '<div class="group">' +
        '<div class="row"><div class="grow"><div class="title">What is stored</div><div class="detail" style="white-space:normal">The card you create (name, headline, links, contact details you choose to share) and the people you save, with when, where, and at what event you met them, plus your private notes.</div></div></div>' +
        '<div class="row"><div class="grow"><div class="title">Where it lives</div><div class="detail" style="white-space:normal">In your own Tagg database (Cloudflare KV) tied to your identity, plus a cache on your device. Your notes and photos are private to your account.</div></div></div>' +
        '<div class="row"><div class="grow"><div class="title">Google sign-in</div><div class="detail" style="white-space:normal">If you sign in with Google, Tagg stores your Google account ID and email to link your database to you. Nothing is posted to Google and no other Google data is read.</div></div></div>' +
        '<div class="row"><div class="grow"><div class="title">Sharing</div><div class="detail" style="white-space:normal">Your card is public to anyone you show your QR code or link to - that is the point of the app. Your people list, notes, and location history are never shared.</div></div></div>' +
        '</div>' +
        '<p class="footer-note">Contact: prajval.2029@gmail.com</p>');
      return;
    }
    if (h === "#/edit") return renderEdit();
    if (h === "#/people") { refreshSoon(); return renderPeople(); }
    if (h === "#/ask") { refreshSoon(); return renderAsk(); }
    if (h === "#/settings") { refreshSoon(); return renderSettings(); }
    if (h === "#/map") { refreshSoon(); return renderMap(); }
    refreshSoon();
    return renderHome();
  }
  window.addEventListener("hashchange", route);

  function shell(active, inner) {
    var card = loadCard();
    app.innerHTML =
      '<div class="topbar"><div class="wordmark"><img class="mark" src="icon.svg" alt="" width="30" height="30">Tagg</div>' +
      '<div class="sub">Meet once. Tagg remembers.</div></div>' +
      '<div class="content">' + inner + '</div>' +
      (card ? tabbarHtml(active) : "");
  }
  function tabbarHtml(active) {
    function tab(id, href, icon, label) {
      var badge = (id === "people" && INBOX_COUNT) ? '<span class="tabbadge"></span>' : "";
      return '<a class="tab' + (active === id ? " active" : "") + '" href="' + href + '"' + (active === id ? ' aria-current="page"' : "") + '>' + icon + badge + '<span>' + label + '</span></a>';
    }
    return '<nav class="tabbar" aria-label="Main">' +
      tab("card", "#/", IC.card, "My Card") +
      tab("people", "#/people", IC.people, "People") +
      tab("map", "#/map", IC.map, "Map") +
      tab("ask", "#/ask", IC.ask, "Ask") +
      tab("settings", "#/settings", IC.settings, "Settings") +
      '</nav>';
  }

  /* ================= home / my card ================= */
  function renderHome() {
    var card = loadCard();
    if (!card) return renderOnboarding();
    var people = loadPeople();
    var url = cardUrl(card);
    var qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    var img = qr.createDataURL(6, 6);

    shell("card",
      '<h1 class="largetitle">Your Tagg</h1>' +
      scanBannerHtml() +
      '<p class="lead">Show the QR when you meet someone. They scan it - no app to install - and you both walk away remembered.</p>' +
      cardHtml(card) +
      '<div style="height:16px"></div>' +
      '<div class="qrwrap"><img alt="Your Tagg QR code" src="' + img + '"></div>' +
      '<p class="qrcaption"><b>' + esc(card.name.split(" ")[0]) + " - your Tagg code</b><br>Point any phone camera at it.</p>" +
      '<div style="height:18px"></div>' +
      '<div class="btnrow">' +
      '<button class="btn btn-tinted" id="copylink">Copy link</button>' +
      '<a class="btn btn-gray" href="#/edit">Edit card</a>' +
      '</div>' +
      '<button class="btn btn-gray" id="wallet">Add to Apple Wallet</button>' +
      '<div style="height:10px"></div>' +
      '<button class="btn btn-gray" id="install" style="display:none">Install Tagg on your phone</button>' +
      '<div style="height:16px"></div>' +
      (!profile() ? '<h2 class="section">Back up and sync</h2><div id="gsign"></div><p class="hint" style="margin-top:8px">Sign in so your card and the people you meet survive a new phone or a cleared browser.</p>' : "") +
      (INBOX_COUNT ? '<h2 class="section">Requests</h2><a class="group" style="display:block;text-decoration:none;color:inherit" href="#/people"><div class="row"><div class="avatar" style="background:var(--card-2);color:var(--accent-2)">' + IC.people + '</div><div class="grow"><div class="title">' + INBOX_COUNT + ' connection request' + (INBOX_COUNT > 1 ? "s" : "") + '</div><div class="detail">Tap to connect back and save the moment</div></div>' + IC.chev + '</div></a>' : "") +
      '<h2 class="section">Recently met</h2>' +
      (people.length ? recentHtml(people) :
        '<div class="group"><div class="row"><div class="grow"><div class="detail" style="white-space:normal">No one saved yet. When someone scans your code and saves you - or you scan theirs - they show up here.</div></div></div></div>') +
      '<h2 class="section">Connect Tagg to your AI</h2>' +
      '<a class="group" style="display:block;text-decoration:none;color:inherit" href="#/settings"><div class="row"><div class="grow"><div class="title">Let your own AI agent search who you have met</div><div class="detail" style="white-space:normal">Read-only, private notes off by default, revocable any time. Set up in Settings.</div></div>' + IC.chev + '</div></a>' +
      '<p class="footer-note">Your card and the people you meet live in your own Tagg database - synced, backed up, and always recallable.<br>Tagg is live at ' + esc(location.host) + '.</p>'
    );
    document.getElementById("copylink").addEventListener("click", function () {
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(function () { toast("Link copied"); }, function () { toast("Copy failed - long-press the QR page URL"); });
    });
    document.getElementById("wallet").addEventListener("click", function () {
      var btn = this;
      consentThen("wallet", "Make a Wallet pass?",
        "To build the pass, Tagg sends your card to a free third-party Wallet signing service (walletmcppass.com): your name, headline, links, email and your card link. Tagg does not control that service. Your QR in the app does the same job without it.",
        "Send my card and make the pass", function () { makePass(btn); });
    });
    function makePass(btn) {
      btn.disabled = true; btn.textContent = "Making your Wallet pass...";
      api("/api/pass", { method: "POST", body: {} }).then(function (d) {
        btn.disabled = false; btn.textContent = "Add to Apple Wallet";
        window.location.href = d.download_url;
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = "Add to Apple Wallet";
        toast((e && e.error) || "Wallet pass unavailable - your QR does the same job");
      });
    }
    var inst = document.getElementById("install");
    if (deferredInstall || isIosUninstalled()) inst.style.display = "";
    inst.addEventListener("click", function () {
      if (deferredInstall) {
        deferredInstall.prompt();
        deferredInstall.userChoice.then(function () { deferredInstall = null; inst.style.display = "none"; });
        return;
      }
      var bg = document.createElement("div");
      bg.className = "sheet-bg";
      bg.innerHTML = '<div class="sheet"><div class="grab"></div><h3>Install Tagg</h3>' +
        '<p class="hint">In Safari: tap the Share button, then "Add to Home Screen". Tagg then opens full-screen from your home screen, like a native app.</p>' +
        '<button class="btn btn-gray" id="closesheet">Got it</button></div>';
      document.body.appendChild(bg);
      bg.addEventListener("click", function (e) { if (e.target === bg) bg.remove(); });
      bg.querySelector("#closesheet").addEventListener("click", function () { bg.remove(); });
    });
    var gsign = document.getElementById("gsign");
    if (gsign) mountGoogleButton(gsign);
  }
  /* ================= settings ================= */
  function renderSettings() {
    var card = loadCard();
    if (!card) { location.hash = "#/"; return; }
    shell("settings",
      '<h1 class="largetitle">Settings</h1>' +
      '<p class="lead">Your account, what people see, your AI connection and how Tagg looks.</p>' +
      '<h2 class="section">Account</h2>' +
      (profile()
        ? '<div class="group"><div class="row"><div class="grow"><div class="detail" style="white-space:normal">Signed in as <b>' + esc(profile().email) + '</b> - your card and people are backed up to your Tagg account.</div></div></div>' +
          '<div class="row"><div class="grow"><div class="detail" style="white-space:normal">Delete your account and the data stored for it.</div></div><button class="btn btn-gray" id="delete-account" style="width:auto;padding:0 14px">Delete account</button></div>' +
          (profile().kind === "email" ? (profile().emailVerified ? '<div class="row"><div class="grow"><div class="detail">Email verified</div></div></div>' : '<div class="row"><div class="grow"><div class="detail" style="white-space:normal">Email not verified yet. Other people see your card as unverified.</div></div><button class="btn btn-tinted" id="verify-email" style="width:auto;padding:0 14px">Verify email</button></div>') : '') + '</div>'
        : '') +
      (!profile() ? '<div class="group"><div class="row"><div class="grow"><div class="detail" style="white-space:normal">You are not signed in. Go to My Card to sign in and back up your Tagg.</div></div><a class="btn btn-tinted" href="#/" style="width:auto;padding:0 14px">My Card</a></div></div>' : '') +
      '<h2 class="section">What people see</h2>' +
      '<div class="panel" id="sharedprofile"><div class="fineprint" style="margin:0">Loading your shared profile...</div></div>' +
      '<h2 class="section">Connect your own agent</h2>' + (profile() ? '<div class="panel" id="agentpanel"><div class="fineprint" style="margin:0">Loading...</div></div>' : '<div class="group"><div class="row"><div class="grow"><div class="detail" style="white-space:normal">Sign in first, then you can connect an AI agent of your choice.</div></div></div></div>') +
      '<h2 class="section">Appearance</h2><div class="themeseg" id="themeseg"><button data-th="light">Light</button><button data-th="dark">Dark</button></div>' +
      '<p class="footer-note"><a href="#/privacy">Privacy</a></p>'
    );
    (function () {
      var cur = localStorage.getItem("tagg.theme") === "dark" ? "dark" : "light";
      [].forEach.call(document.querySelectorAll("#themeseg button"), function (b) {
        if (b.getAttribute("data-th") === cur) b.className = "on";
        b.addEventListener("click", function () { setTheme(b.getAttribute("data-th")); route(); });
      });
    })();
    (function () {
      var el = document.getElementById("sharedprofile");
      function show(en) {
        if (!el || !document.body.contains(el)) return;
        var links = Object.keys(card.links || {}).join(", ");
        el.innerHTML = '<div class="fineprint" style="margin:0 0 8px">This is your card as someone sees it after they scan your code and save you.</div>' +
          cardHtml(card) + enrichHtml({ enriched: en, card: card, slug: cardSlug() }) +
          '<h3 style="font-size:15px;margin:14px 0 4px">Shared</h3><div class="fineprint" style="margin:0">Name, headline' + (links ? ", links (" + esc(links) + ")" : "") + (card.email ? ", email" : "") + (card.phone ? ", phone" : "") + (en && en.linkedin ? ", the LinkedIn details above" : "") + '.</div>' +
          '<h3 style="font-size:15px;margin:10px 0 4px">Private to you</h3><div class="fineprint" style="margin:0">Your notes, places and photos about people, who you saved, and your Ask questions. Never shown to anyone you meet.</div>' +
          '<a class="btn btn-gray" href="#/edit" style="margin-top:10px">Edit shared details</a>';
      }
      show(null);
      if (cardSlug()) api("/api/c/" + cardSlug()).then(function (d) { show(d.enriched || null); }).catch(function () {});
    })();
    (function () {
      var el = document.getElementById("agentpanel"); if (!el) return;
      var shown = null;
      function fmt(ts) { return ts ? new Date(ts).toLocaleDateString() : "never"; }
      function draw(list) {
        if (!document.body.contains(el)) return;
        el.innerHTML = '<div class="fineprint" style="margin:0 0 10px">Let an AI agent you choose search the people you have met. Read-only. Each connection has its own key that you can remove at any time, and it stops working immediately.</div>' +
          '<div class="fineprint" style="margin:0 0 10px">Server address (MCP over HTTP, Bearer key): <code>' + esc(API + "/api/mcp") + '</code><br>Works with clients that accept a custom server URL and Authorization header. It does not use sign-in pages, so apps that only offer one-click connectors will not work with it yet.</div>' +
          (shown ? '<div class="tokenbox"><b>Copy this key now. It is shown once.</b><code id="tokval">' + esc(shown.token) + '</code><div class="fineprint" style="margin:6px 0">Send the key as a Bearer token. Anyone holding it can read what you allowed below.</div><button class="btn btn-tinted" id="tokcopy">Copy key</button> <button class="btn btn-gray" id="tokdone" style="margin-top:8px">I saved it</button></div>' : "") +
          (list.length ? list.map(function (t) {
            return '<div class="row" style="padding:8px 0"><div class="grow"><div class="title">' + esc(t.name) + '</div><div class="detail">' + (t.scope === "people+notes" ? "People and your private notes" : "People only, no notes") + ' - last used ' + fmt(t.lastUsed) + ' - expires ' + fmt(t.expires) + '</div></div><button class="btn btn-gray" data-rev="' + esc(t.id) + '" style="width:auto;padding:0 14px">Remove</button></div>';
          }).join("") : '<div class="fineprint" style="margin:0 0 10px">No agents connected.</div>') +
          '<div style="height:8px"></div><input class="input" id="agname" placeholder="Name this connection" maxlength="60" aria-label="Connection name">' +
          '<div style="height:8px"></div><select class="input" id="agscope" aria-label="What the agent may read"><option value="people">People only (no private notes)</option><option value="people+notes">People and my private notes</option></select>' +
          '<p class="fineprint" style="margin:8px 0">If you include notes, the agent provider you connect will see them. Tagg does not choose or verify that provider. Details from LinkedIn are shown as not verified by Tagg.</p>' +
          '<button class="btn btn-accent" id="agadd">Create connection key</button>';
        [].forEach.call(el.querySelectorAll("[data-rev]"), function (b) {
          b.addEventListener("click", function () { api("/api/tokens/" + b.getAttribute("data-rev"), { method: "DELETE" }).then(load).catch(function () { toast("Could not remove it"); }); });
        });
        var add = el.querySelector("#agadd");
        add.addEventListener("click", function () {
          var name = el.querySelector("#agname").value.trim(), scope = el.querySelector("#agscope").value;
          if (!name) { toast("Name this connection first"); return; }
          add.disabled = true;
          api("/api/tokens", { method: "POST", body: { name: name, scope: scope } }).then(function (d) { shown = d; load(); })
            .catch(function (e) { add.disabled = false; toast((e && e.error) || "Could not create it"); });
        });
        var tc = el.querySelector("#tokcopy");
        if (tc) tc.addEventListener("click", function () { (navigator.clipboard ? navigator.clipboard.writeText(shown.token) : Promise.reject()).then(function () { toast("Key copied"); }, function () { toast("Copy failed - select and copy the key"); }); });
        var td = el.querySelector("#tokdone"); if (td) td.addEventListener("click", function () { shown = null; load(); });
      }
      function load() { api("/api/tokens").then(function (d) { draw(d.tokens || []); }).catch(function () { el.innerHTML = '<div class="fineprint" style="margin:0">Could not load. Check your connection.</div>'; }); }
      load();
    })();
    var da = document.getElementById("delete-account"); if (da) da.addEventListener("click", showDeleteAccount);
    var ve = document.getElementById("verify-email"); if (ve) ve.addEventListener("click", showVerifyEmail);
  }
  function recentHtml(people) {
    var rows = people.slice(0, 3).map(function (p) {
      return '<a class="row" href="#/p/' + p.id + '">' +
        '<div class="avatar">' + esc(initial(p.card.name)) + '</div>' +
        '<div class="grow"><div class="title">' + esc(p.card.name) + '</div>' +
        '<div class="detail">' + esc(p.event || "Somewhere") + " · " + fmtDate(p.metAt) + '</div></div>' +
        IC.chev + '</a>';
    }).join("");
    return '<div class="group">' + rows + '</div>' +
      (people.length > 3 ? '<div style="height:10px"></div><a class="btn btn-plain" href="#/people">See all ' + people.length + ' people</a>' : "");
  }

  /* ================= onboarding / edit ================= */
  function renderOnboarding() {
    shell(null,
      '<h1 class="largetitle">The people you meet,<br>remembered.</h1>' +
      '<p class="lead">Tagg is a people memory with a personal agent. Make your card once - then anyone you meet scans your code, gets your links, and saves the moment. No app for them to install.</p>' +
      '<div class="group">' +
      feat("Show your code", "They scan it and get your card - name, socials, links.") +
      feat("The moment, saved", "When you met, where, and at which event. Dictate a quick note, add a selfie.") +
      feat("Just ask", '"Who did I meet at Cal Hacks who works on robotics?" Tagg answers.') +
      feat("Follow up", 'Tell Tagg "set up a call" - your agent works it out with theirs.') +
      '</div>' +
      '<div style="height:22px"></div>' +
      '<a class="btn btn-accent" href="#/edit">Create your card</a>' +
      '<div style="height:18px"></div>' +
      '<h2 class="section">Already have Tagg?</h2>' +
      '<div id="gsign"></div>' +
      '<p class="hint" style="margin-top:8px">Sign in to pull your card and your people onto this device.</p>' +
      '<p class="footer-note">Your card and people are stored in your Tagg account.</p>'
    );
    var gsign = document.getElementById("gsign");
    if (gsign) mountAuthBlock(gsign, { mode: "login" });
    function feat(t, d) {
      return '<div class="row"><div class="grow"><div class="title">' + t + '</div><div class="detail" style="white-space:normal">' + d + '</div></div></div>';
    }
  }

  /* LinkedIn import: paste your profile text, review what was found, then add it. LinkedIn itself is never contacted. */
  function mountLinkedinImport(collect, onHeadline) {
    var box = document.getElementById("liimport"); if (!box) return;
    function list(a) { return (a || []).filter(Boolean).join(", "); }
    function summary(li) {
      return '<div class="panel"><div style="font-weight:600">Imported from LinkedIn</div>' +
        (li.hasPhoto && cardSlug() ? '<div style="display:flex;align-items:center;gap:12px;margin-top:8px"><img class="avatar-img" src="' + esc(API + "/api/photo/" + cardSlug() + "?v=" + encodeURIComponent(li.importedAt || "")) + '" alt="" style="width:48px;height:48px"><button class="btn btn-plain" id="li-rmphoto" style="margin:0">Remove photo</button></div>' : "") +
        '<div style="color:var(--text-2);font-size:13px;margin-top:4px;line-height:1.5">' +
        [li.titles && li.titles.length ? list(li.titles) : li.title, list(li.companies && li.companies.length ? li.companies : [li.company]), list(li.schools && li.schools.length ? li.schools : [li.school]), li.location].filter(Boolean).map(esc).join("<br>") +
        '</div><div class="fineprint" style="margin-top:6px">Shown to people who scan your code and used when you ask Tagg who you met.</div>' +
        '<button class="btn btn-gray" id="li-edit" style="margin-top:8px">Edit details</button> ' +
        '<button class="btn btn-plain" id="li-remove" style="margin-top:4px">Remove imported details</button></div>';
    }
    function idle(li) {
      box.innerHTML = (li ? summary(li) : "") + '<button class="btn btn-gray" id="li-open" style="margin:8px 0 4px">' + (li ? "Import again" : "Import school and work from LinkedIn") + '</button>';
      document.getElementById("li-open").addEventListener("click", ask);
      var rp = document.getElementById("li-rmphoto");
      if (rp) rp.addEventListener("click", function () { api("/api/profile-photo", { method: "DELETE" }).then(function () { toast("Photo removed"); li.hasPhoto = false; idle(li); }).catch(function () { toast("Could not remove - try again"); }); });
      var ed = document.getElementById("li-edit");
      if (ed && li) ed.addEventListener("click", function () { review({ fields: li, edit: true }); });
      var rm = document.getElementById("li-remove");
      if (rm) rm.addEventListener("click", function () {
        api("/api/import/linkedin", { method: "DELETE" }).then(function () { toast("Imported details removed"); idle(null); }).catch(function () { toast("Could not remove - try again"); });
      });
    }
    function ask() {
      box.innerHTML = '<div class="panel"><div style="font-weight:600">Import from LinkedIn</div>' +
        '<p class="hint" style="margin:6px 0 8px;line-height:1.45">Uses the LinkedIn link above. Tagg reads the public parts of your profile (school, jobs, place), then you review it before anything is saved.</p>' +
        '<label class="row" style="gap:12px;cursor:pointer"><input type="checkbox" id="li-own" style="width:18px;height:18px;accent-color:var(--accent)"><span class="grow detail" style="white-space:normal">This is my own LinkedIn profile.</span></label>' +
        '<button class="btn btn-accent" id="li-link" style="margin-top:8px">Import from my link</button>' +
        '<p class="hint" style="margin:12px 0 6px;line-height:1.45">No link, or it did not work? Paste your profile text instead.</p>' +
        '<textarea class="input" id="li-text" rows="4" placeholder="Paste your profile text"></textarea>' +
        '<button class="btn btn-gray" id="li-read" style="margin-top:8px">Read pasted text</button>' +
        '<button class="btn btn-plain" id="li-cancel">Cancel</button><div class="fineprint" id="li-err" style="color:var(--danger,#c0392b)"></div></div>';
      document.getElementById("li-cancel").addEventListener("click", function () { load(); });
      function run(btn, label, payload, consentKey, consentTitle, consentBody) {
        var err = document.getElementById("li-err"), c = collect(); err.textContent = "";
        if (!c.name) { err.textContent = "Add your name above first."; return; }
        consentThen(consentKey, consentTitle, consentBody, "Continue", function () {
          btn.disabled = true; btn.textContent = "Reading...";
          Object.keys(c.links).forEach(function (k) { if (!c.links[k]) delete c.links[k]; });
          saveCard(c);
          syncCard().then(function () { return api("/api/import/linkedin", { method: "POST", body: payload(c) }); }).then(review).catch(function (e) {
            btn.disabled = false; btn.textContent = label; err.textContent = (e && e.error) || "Could not read that. Try again.";
          });
        });
      }
      document.getElementById("li-link").addEventListener("click", function () {
        var err = document.getElementById("li-err");
        if (!collect().links.linkedin) { err.textContent = "Add your LinkedIn link above first."; return; }
        if (!document.getElementById("li-own").checked) { err.textContent = "Tick the box to confirm it is your own profile."; return; }
        run(this, "Import from my link", function (c) { return { url: c.links.linkedin, ownProfile: true }; }, "lilink", "Read your public LinkedIn profile?",
          "Tagg asks a data service (Apify) to read the public parts of your LinkedIn profile from your link. Nothing is saved until you review it. Only import your own profile.");
      });
      document.getElementById("li-read").addEventListener("click", function () {
        var text = document.getElementById("li-text").value;
        if (text.trim().length < 40) { document.getElementById("li-err").textContent = "Paste the text of your profile first."; return; }
        run(this, "Read pasted text", function (c) { return { url: c.links.linkedin || "", text: text }; }, "liimport", "Read your profile text with Cloudflare AI?",
          "Tagg sends the text you paste to Cloudflare Workers AI, which also hosts Tagg, to pick out your job, employer and school. Tagg never contacts LinkedIn. Nothing is saved until you review it.");
      });
    }
    function review(d) {
      var f = d.fields;
      function fld(id, label, val) { return '<div class="field"><label>' + label + '</label><input class="input" id="' + id + '" value="' + esc(val || "") + '"></div>'; }
      box.innerHTML = '<div class="panel"><div style="font-weight:600">Check what Tagg found</div>' +
        '<p class="hint" style="margin:6px 0 8px;line-height:1.45">' + (d.edit ? "Fix anything or clear what you do not want. Cleared details stay cleared. Tagg has not verified this." : "Only what the profile shows. Fix anything, clear what you do not want. Nothing is saved until you add it.") + '</p>' +
        fld("li-headline", "Headline", f.headline) + fld("li-titles", "Roles, separated by commas", list(f.titles)) +
        fld("li-companies", "Employers", list(f.companies)) + fld("li-schools", "Schools", list(f.schools)) + fld("li-location", "Location", f.location) +
        '<div class="fineprint">Shown to people who scan your code.</div>' +
        '<button class="btn btn-accent" id="li-add" style="margin-top:8px">' + (d.edit ? "Save changes" : "Add to my card") + '</button>' +
        '<button class="btn btn-plain" id="li-discard">Discard</button><div class="fineprint" id="li-err2"></div></div>';
      document.getElementById("li-discard").addEventListener("click", function () { load(); });
      document.getElementById("li-add").addEventListener("click", function () {
        var btn = this; btn.disabled = true;
        function split(id) { return document.getElementById(id).value.split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean); }
        var fields = { headline: document.getElementById("li-headline").value.trim(), titles: split("li-titles"), companies: split("li-companies"), schools: split("li-schools"), location: document.getElementById("li-location").value.trim() };
        (d.edit ? api("/api/import/linkedin/edit", { method: "POST", body: { fields: fields } }) : api("/api/import/linkedin/confirm", { method: "POST", body: { previewId: d.previewId, fields: fields } })).then(function (r) {
          toast("Added to your card"); onHeadline(fields.headline); idle(r.linkedin);
        }).catch(function (e) { btn.disabled = false; document.getElementById("li-err2").textContent = (e && e.error) || "Could not save - try again"; });
      });
    }
    function load() {
      idle(null);
      var slug = cardSlug();
      if (slug) api("/api/c/" + slug).then(function (d) { if (d.enriched && d.enriched.linkedin) idle(d.enriched.linkedin); }).catch(function () {});
    }
    load();
  }
  /* Adding or changing a LinkedIn or GitHub link: tell the owner, before saving, what Tagg will read and where it goes. Nothing is pre-ticked. */
  function askAutoImport(c, which) {
    var li = which.indexOf("linkedin") >= 0, gh = which.indexOf("github") >= 0;
    var reads = [];
    if (li) reads.push("LinkedIn: Tagg asks a data service (Apify) to read the public parts of your profile (headline, roles, employers, schools, place, profile picture)");
    if (gh) reads.push("GitHub: Tagg reads your public GitHub profile (name, bio, company, place, picture, follower and repository counts) from GitHub's public API");
    var bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet"><div class="grab"></div><h3>Fill your card from ' + (li && gh ? "LinkedIn and GitHub" : li ? "LinkedIn" : "GitHub") + '?</h3>' +
      '<p class="hint" style="line-height:1.45">If you save with import, ' + reads.map(esc).join(". ") + '. They fill your shared card and are shown to people you connect with. You can edit or remove them afterwards. Tagg has not verified them.</p>' +
      '<label class="row" style="gap:12px;cursor:pointer"><input type="checkbox" id="ai-own" style="width:18px;height:18px;accent-color:var(--accent)"><span class="grow detail" style="white-space:normal">' + (li && gh ? "These are my own profiles" : "This is my own profile") + ', and I agree to this.</span></label>' +
      '<button class="btn btn-accent" id="ai-yes" style="margin-top:10px" disabled>Save and import</button>' +
      '<button class="btn btn-gray" id="ai-link">Save link only</button>' +
      '<button class="btn btn-plain" id="ai-no">Cancel</button><div class="fineprint" id="ai-err"></div></div>';
    document.body.appendChild(bg);
    var yes = bg.querySelector("#ai-yes");
    bg.querySelector("#ai-own").addEventListener("change", function () { yes.disabled = !this.checked; });
    bg.querySelector("#ai-no").addEventListener("click", function () { bg.remove(); });
    function persist() { saveCard(c); lastSync = 0; return syncCard(); }
    bg.querySelector("#ai-link").addEventListener("click", function () { bg.remove(); persist().then(function () { toast("Card saved"); location.hash = "#/"; }); });
    yes.addEventListener("click", function () {
      yes.disabled = true; yes.textContent = "Importing...";
      var firstErr = "", did = 0;
      persist().then(function () {
        return which.reduce(function (chain, k) {
          return chain.then(function () {
            return api("/api/import/" + k + "/auto", { method: "POST", body: { url: c.links[k], ownProfile: true, disclosure: k === "linkedin" ? "linkedin-auto-v2" : "github-auto-v1" } }).then(function () { did++; }).catch(function (e) { if (!firstErr) firstErr = (e && e.error) || "Could not import right now."; });
          });
        }, Promise.resolve());
      }).then(function () {
        bg.remove(); toast(did ? "Card saved and filled from " + (did > 1 ? "your profiles" : which.length === 1 ? (li ? "LinkedIn" : "GitHub") : "one profile") + (firstErr ? ". " + firstErr : "") : firstErr || "Card saved"); renderEdit();
      });
    });
  }
  /* GitHub details on the edit page: shown after import, with edit and remove. */
  function mountGithubPanel() {
    var box = document.getElementById("ghimport"); if (!box) return;
    function summary(g) {
      return '<div class="panel"><div style="font-weight:600">Imported from GitHub</div>' +
        '<div style="color:var(--text-2);font-size:13px;margin-top:4px;line-height:1.5">' +
        [g.name || g.login, g.bio, g.company, g.location, (g.followers != null ? g.followers + " followers" : "") + (g.repos != null ? ", " + g.repos + " public repos" : "")].filter(Boolean).map(esc).join("<br>") +
        '</div><div class="fineprint" style="margin-top:6px">Shown to people you connect with. Tagg has not verified it.</div>' +
        '<button class="btn btn-gray" id="gh-edit" style="margin-top:8px">Edit details</button> <button class="btn btn-plain" id="gh-remove" style="margin-top:4px">Remove imported details</button></div>';
    }
    function show(g) {
      box.innerHTML = g ? summary(g) : "";
      var rm = document.getElementById("gh-remove"), ed = document.getElementById("gh-edit");
      if (rm) rm.addEventListener("click", function () { api("/api/import/github", { method: "DELETE" }).then(function () { toast("Imported details removed"); show(null); }).catch(function () { toast("Could not remove - try again"); }); });
      if (ed) ed.addEventListener("click", function () {
        function fld(id, label, val) { return '<div class="field"><label>' + label + '</label><input class="input" id="' + id + '" value="' + esc(val || "") + '"></div>'; }
        box.innerHTML = '<div class="panel"><div style="font-weight:600">Edit GitHub details</div><p class="hint" style="margin:6px 0 8px;line-height:1.45">Fix anything or clear what you do not want. Cleared details stay cleared.</p>' +
          fld("gh-name", "Name", g.name) + fld("gh-bio", "Bio", g.bio) + fld("gh-company", "Company", g.company) + fld("gh-loc", "Location", g.location) +
          '<button class="btn btn-accent" id="gh-save" style="margin-top:8px">Save changes</button><button class="btn btn-plain" id="gh-cancel">Discard</button><div class="fineprint" id="gh-err"></div></div>';
        document.getElementById("gh-cancel").addEventListener("click", function () { show(g); });
        document.getElementById("gh-save").addEventListener("click", function () {
          var f = { name: document.getElementById("gh-name").value, bio: document.getElementById("gh-bio").value, company: document.getElementById("gh-company").value, location: document.getElementById("gh-loc").value };
          api("/api/import/github/edit", { method: "POST", body: { fields: f } }).then(function (r) { toast("Saved"); show(r.github); }).catch(function (e) { document.getElementById("gh-err").textContent = (e && e.error) || "Could not save - try again"; });
        });
      });
    }
    var slug = cardSlug();
    if (slug) api("/api/c/" + slug).then(function (d) { if (d.enriched && d.enriched.github) show(d.enriched.github); }).catch(function () {});
  }
  function renderEdit() {
    var c = loadCard() || { name: "", headline: "", email: "", phone: "", links: {} };
    shell(null,
      '<h1 class="largetitle">' + (loadCard() ? "Edit card" : "Your card") + '</h1>' +
      '<p class="lead">This is what people see when they scan your code.</p>' +
      '<div class="field"><label>Name</label><input class="input" id="f-name" placeholder="Prajval Arora" value="' + esc(c.name) + '"></div>' +
      '<div class="field"><label>Headline</label><input class="input" id="f-head" placeholder="Robotics engineering at ASU" value="' + esc(c.headline) + '"></div>' +
      '<div class="field"><label>LinkedIn</label><input class="input" id="f-linkedin" placeholder="username or URL" value="' + esc(c.links.linkedin || "") + '"></div>' +
      '<div id="liimport"></div>' +
      '<div class="field"><label>GitHub</label><input class="input" id="f-github" placeholder="username or URL" value="' + esc(c.links.github || "") + '"></div>' +
      '<div id="ghimport"></div>' +
      '<div class="field"><label>X</label><input class="input" id="f-x" placeholder="handle" value="' + esc(c.links.x || "") + '"></div>' +
      '<div class="field"><label>Instagram</label><input class="input" id="f-instagram" placeholder="handle" value="' + esc(c.links.instagram || "") + '"></div>' +
      '<div class="field"><label>Website</label><input class="input" id="f-website" placeholder="prajvalarora.com" value="' + esc(c.links.website || "") + '"></div>' +
      '<div class="field"><label>Email</label><input class="input" id="f-email" type="email" placeholder="you@example.com" value="' + esc(c.email) + '"></div>' +
      '<div class="field"><label>Phone</label><input class="input" id="f-phone" type="tel" placeholder="+1 ..." value="' + esc(c.phone) + '"></div>' +
      '<h2 class="section">Preview</h2>' +
      '<div id="preview"></div>' +
      '<div style="height:18px"></div>' +
      '<button class="btn btn-accent" id="save">Save card</button>' +
      '<div style="height:110px" aria-hidden="true"></div>'
    );
    function collect() {
      return {
        name: v("f-name"), headline: v("f-head"),
        email: v("f-email"), phone: v("f-phone"),
        links: {
          linkedin: normUrl("linkedin", v("f-linkedin")),
          github: normUrl("github", v("f-github")),
          x: normUrl("x", v("f-x")),
          instagram: normUrl("instagram", v("f-instagram")),
          website: normUrl("website", v("f-website"))
        }
      };
    }
    function v(id) { return document.getElementById(id).value.trim(); }
    function refresh() {
      var c = collect();
      document.getElementById("preview").innerHTML = cardHtml(c.name ? c : { name: "Your Name", headline: "Your headline", links: {} });
    }
    Array.prototype.forEach.call(document.querySelectorAll(".input"), function (i) {
      i.addEventListener("input", refresh);
    });
    refresh();
    mountGithubPanel();
    mountLinkedinImport(collect, function (headline) { var h = document.getElementById("f-head"); if (headline && !h.value.trim()) { h.value = headline; refresh(); } });
    document.getElementById("save").addEventListener("click", function () {
      var c = collect();
      if (!c.name) { toast("Add your name first"); return; }
      Object.keys(c.links).forEach(function (k) { if (!c.links[k]) delete c.links[k]; });
      var prevLinks = (loadCard() || { links: {} }).links || {};
      var changed = [];
      if (c.links.linkedin && c.links.linkedin !== (prevLinks.linkedin || "")) changed.push("linkedin");
      if (changed.length) { askAutoImport(c, changed); return; }
      saveCard(c);
      lastSync = 0;
      syncCard().then(function (d) {
        if (d) { toast("Card saved to your Tagg database"); lastSync = 0; route(); }
      });
      toast("Card saved");
      location.hash = "#/";
    });
  }

  /* ================= scanned card ================= */
  function renderScannedRoute(id) {
    if (/^[a-z0-9]{6,10}$/.test(id)) {
      shell(null, '<div class="empty"><div class="t">Pulling up their card...</div><div class="d">One second.</div></div>');
      // Anonymous "someone scanned" ping so the owner's app updates at once. Carries no identity, once per tab session.
      if (cardSlug() !== id && !sessionStorage.getItem("tagg.pinged." + id)) {
        sessionStorage.setItem("tagg.pinged." + id, "1");
        fetch(API + "/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug: id }) }).catch(function () {});
      }
      api("/api/c/" + id).then(function (d) { renderScanned(d.card, id, d.enriched, d.verified); }).catch(function () {
        shell(null, '<div class="empty"><div class="t">That code did not scan right</div><div class="d">Ask them to show their Tagg code again.</div></div><a class="btn btn-gray" href="#/">Back</a>');
      });
      return;
    }
    renderScanned(decodePayload(id), null, null);
  }
  function renderScanned(c, slug, enriched, verified) {
    if (!c) {
      shell(null, '<div class="empty"><div class="t">That code did not scan right</div><div class="d">Ask them to show their Tagg code again.</div></div><a class="btn btn-gray" href="#/">Back</a>');
      return;
    }
    var first = esc(c.name.split(" ")[0]);
    var mine = loadCard();
    if (!slug) {  /* legacy base64 card: instant local save */
      shell(null,
        '<span class="pill">You just met</span>' +
        '<h1 class="largetitle">' + esc(c.name) + '</h1>' +
        cardHtml(c) +
        '<div style="height:18px"></div>' +
        '<div class="field"><label>Where did you meet? (event or place)</label>' +
        '<input class="input" id="f-event" placeholder="Cal Hacks, Berkeley"></div>' +
        '<button class="btn btn-accent" id="savemeet">Save to Tagg</button>' +
        '<a class="btn btn-plain" href="#/">Make your own Tagg card</a>');
      document.getElementById("savemeet").addEventListener("click", function () {
        var eventName = document.getElementById("f-event").value.trim();
        withLocation(function (loc) {
          var person = { id: uid(), card: c, metAt: new Date().toISOString(), event: eventName, location: loc, note: "" };
          var people = loadPeople(); people.unshift(person); savePeople(people);
          toast("Saved to Tagg"); location.hash = "#/p/" + person.id;
        });
      });
      return;
    }
    // Signed in = we know who you are (a card or a profile exists on this device).
    var signedIn = !!(mine || profile());
    var guest = false;
    // Optional context shared by both paths: note (with voice-to-text), event, and a location toggle.
    var contextHtml =
      '<div class="field"><label>Where are you two? <span style="text-transform:none;color:var(--text-3);font-weight:400">(optional)</span></label><input class="input" id="f-event" placeholder="Cal Hacks, Berkeley"></div>' +
      '<div class="field"><label>Context <span style="text-transform:none;color:var(--text-3);font-weight:400">(optional - private to you)</span></label>' +
      '<textarea class="input" id="f-note" placeholder="What are you two talking about?"></textarea></div>' +
      '<div style="height:8px"></div><button class="btn btn-gray" id="f-dictate">' + IC.mic + ' Dictate</button>' +
      '<div class="locstatus" id="locstatus">Finding where you are...</div>' +
      '<label class="row" id="shareloc-row" style="margin-top:8px;gap:12px;cursor:pointer"><input type="checkbox" id="f-loc" style="width:18px;height:18px;accent-color:var(--accent)">' +
      '<span class="grow"><span class="title" style="display:block">Also send the place to ' + first + '</span><span class="detail" style="white-space:normal">The place is saved in your own record automatically. It goes to ' + first + ' only if you tick this and share your card. Save only never sends it.</span></span></label>' +
      '';
    shell(null,
      '<span class="pill">You just met</span>' +
      '<h1 class="largetitle">' + esc(c.name) + '</h1>' +
      (slug ? '<p class="fineprint" style="margin:-4px 0 12px">' + (verified ? 'Signed in with Google' : 'Identity not verified - the name and email on this card are what they typed.') + '</p>' : '') +
      '<p class="lead">' + (signedIn ? 'Share your card - ' + first + ' gets a request, and once they accept you both save the moment.' : 'Create your Tagg to connect. ' + first + ' gets your card and you both keep each other.') + '</p>' +
      cardHtml(c) + enrichHtml({ enriched: enriched, card: c, slug: slug }) +
      '<div style="height:18px"></div>' +
      '<div id="connectzone">' +
      (signedIn
        ? contextHtml + '<div style="height:14px"></div><button class="btn btn-accent" id="connect">Share my card with ' + first + '</button>' +
          '<p class="hint" style="margin:8px 4px 0;text-align:center;color:var(--text-2);font-size:12.5px;line-height:1.45">Your Tagg card goes with it automatically.</p>' +
          '<button class="btn btn-gray" id="saveonly" style="margin-top:6px">Save only</button>' +
          '<p class="hint" style="margin:8px 4px 0;text-align:center;color:var(--text-2);font-size:12.5px;line-height:1.45">Keeps ' + first + ' in your people. Shares no name, contact or request. ' + first + ' may see that their card was opened, nothing more.</p>'
        : '<div id="authzone"></div>' +
          '<h2 class="section">Add context <span class="soon">optional</span></h2>' + contextHtml +
          '<div style="height:10px"></div><button class="btn btn-plain" id="guest">Continue without an account</button>' +
          '<button class="btn btn-gray" id="saveonly" style="margin-top:6px">Save only</button>' +
          '<p class="hint" style="margin:8px 4px 0;text-align:center;color:var(--text-2);font-size:12.5px;line-height:1.45">Keeps ' + first + ' on this phone. No account. Shares no name, contact or request; ' + first + ' may see that their card was opened.</p>') +
      '</div>' +
      '<p class="footer-note">Your contact details are not shared until you choose to share them.</p>'
    );
    setupDictate(null, "f-dictate", "f-note");
    // Location is requested the moment the box is ticked (so the phone's permission prompt is answered
    // before Share is pressed) and the status stays visible. The result is reused when sending or saving.
    var locP = null, locBox = document.getElementById("f-loc"), locEl = document.getElementById("locstatus");
    function startLoc() {
      locEl.style.display = "block";
      locP = locate(function (kind, loc) { locEl.innerHTML = locStatusHtml(kind, loc); });
      return locP;
    }
    // Capture starts on its own when the page opens: the phone asks for permission once, and the fix is ready before Save.
    // Capturing is private to this device/account. It is sent to the other person only if the box above is ticked.
    locEl.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute("data-locretry")) { e.preventDefault(); startLoc(); }
    });
    function getLoc() { return (locP || startLoc()).then(function (r) { return r.ok ? r.loc : null; }); }
    startLoc();
    // Third option: just save them. No request, no email, no follow-up. Context and location stay private to the saver.
    document.getElementById("saveonly").addEventListener("click", function () {
      var btn = this; btn.disabled = true; btn.textContent = "Saving...";
      var eventName = document.getElementById("f-event").value.trim();
      var note = document.getElementById("f-note").value.trim();
      if (locP) btn.textContent = "Saving with location...";
      getLoc().then(function (loc) {
        if (ownerToken()) {
          return api("/api/people", { method: "POST", body: { slug: slug, event: eventName, note: note, location: loc } }).then(function (d) {
            return syncPeople().then(function () { return d.person.id; });
          });
        }
        var person = { id: uid(), slug: slug, card: c, metAt: new Date().toISOString(), event: eventName, location: loc, note: note };
        var people = loadPeople(); people.unshift(person); savePeople(people);
        return person.id;
      }).then(function (id) {
        toast("Saved. No details were shared with " + first); location.hash = "#/p/" + id;
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = "Save only";
        toast((e && e.error) || "Could not save - try again");
      });
    });
    // Reads the optional context from the form and sends the connection request.
    function sendConnect(name, contact, btn) {
      var eventName = document.getElementById("f-event").value.trim();
      var note = document.getElementById("f-note").value.trim();
      var wantLoc = locBox.checked;
      if (btn) { btn.disabled = true; btn.textContent = "Sharing..."; }
      function go(loc) {
        ensureOwner().then(function () {
          return api("/api/connect", { method: "POST", body: {
            slug: slug, name: name, contact: contact, event: eventName, note: note, location: loc, requesterToken: ownerToken() } });
        }).then(function (d) {
          setOwnerToken(d.requestToken);
          sentState(d.requestId);
        }).catch(function (e) {
          if (btn) { btn.disabled = false; btn.textContent = "Share my card with " + first; }
          toast((e && e.error) || "Could not reach the database - try again");
        });
      }
      if (btn) btn.textContent = wantLoc ? "Getting location..." : "Sharing...";
      if (!wantLoc) return go(null);
      getLoc().then(function (loc) { if (!loc) toast("Sent without a location"); go(loc); });
    }
    if (signedIn) {
      document.getElementById("connect").addEventListener("click", function () {
        var card = loadCard(), prof = profile() || {};
        sendConnect(card ? card.name : (prof.name || prof.email || "New connection"), card ? (card.email || card.phone || "") : (prof.email || ""), this);
      });
    } else {
      // Sign up as part of the scan: once the account exists we make a basic card from it
      // (so you are reciprocal, not a guest) and the connection request goes out automatically.
      mountAuthBlock(document.getElementById("authzone"), { mode: "signup", cta: "Create account and share with " + first, onDone: function (d, typedName) {
        var prof = d.profile || {};
        var ensureCard = loadCard() ? Promise.resolve() : (function () {
          var card = { name: typedName || prof.name || (prof.email || "").split("@")[0] || "New member", headline: "", email: prof.email || "", phone: "", links: {} };
          saveCard(card);
          return syncCard();
        })();
        ensureCard.then(function () {
          var card = loadCard();
          sendConnect(card.name, card.email || "", null);
        });
      } });
      document.getElementById("guest").addEventListener("click", function () {
        // Guest path (kept from earlier versions): only a name and a way to reach you.
        document.getElementById("connectzone").insertAdjacentHTML("afterbegin",
          '<div class="field"><label>Your name</label><input class="input" id="f-name" placeholder="Your name"></div>' +
          '<div class="field"><label>How to reach you</label><input class="input" id="f-contact" placeholder="you@example.com"></div>');
        document.getElementById("authzone").remove();
        var g = this; g.className = "btn btn-accent"; g.textContent = "Share my contact with " + first; g.id = "connect";
        var fresh = g.cloneNode(true); g.parentNode.replaceChild(fresh, g);
        fresh.addEventListener("click", function () {
          var n = document.getElementById("f-name").value.trim();
          if (!n) { toast("Add your name first"); return; }
          sendConnect(n, document.getElementById("f-contact").value.trim(), fresh);
        });
      });
    }
    function sentState(requestId) {
      document.getElementById("connectzone").innerHTML =
        '<div class="group"><div class="row"><div class="grow">' +
        '<div class="title">Shared with ' + esc(c.name) + '</div>' +
        '<div class="detail" style="white-space:normal" id="cstatus">Request sent. ' + first + ' needs to accept it. Once they do, you are in each other\'s Tagg.</div>' +
        '</div></div></div>' +
        '<div style="height:18px"></div>' +
        (loadCard()
          ? '<h2 class="section" style="margin-top:0">Your Tagg</h2><p class="fineprint">Your card is saved. Add your links so people you meet get more than a name.</p>' +
            '<a class="btn btn-tinted" href="#/edit">Finish my card</a><a class="btn btn-plain" href="#/">Open my dashboard</a>'
          : '<h2 class="section" style="margin-top:0">Want this for yourself?</h2><p class="fineprint">Your own QR, your own people memory - free, 30 seconds.</p>' +
            '<a class="btn btn-tinted" href="#/edit">Make my Tagg</a>');
      var fn = document.querySelector(".footer-note"); if (fn) fn.textContent = "Sent. Nothing else is shared until " + first + " accepts.";
      pollStatus(requestId);
    }
    function pollStatus(requestId) {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (tries > 90 || !document.getElementById("cstatus")) { clearInterval(iv); return; }
        api("/api/connect/status?id=" + requestId).then(function (d) {
          if (d.status === "accepted") {
            clearInterval(iv);
            var el = document.getElementById("cstatus");
            if (el) el.innerHTML = '<b>' + first + ' connected back</b> - you are in each other\'s Tagg.';
            lastSync = 0;
            syncPeople().then(function () { if (d.personId) momentSheet(d.personId); });
          } else if (d.status === "declined") {
            clearInterval(iv);
            var el2 = document.getElementById("cstatus");
            if (el2) el2.textContent = "They passed for now - your details were still delivered.";
          }
        }).catch(function () {});
      }, 8000);
    }
  }

  /* ================= person detail ================= */
  /* Profile sections. Each link the person shared gets its own rounded section. Only GitHub and the details the owner imported are
     shown inside the page; other sites cannot be shown inside Tagg, so those sections open the profile. Nothing here is fetched from a third party. */
  function photoUrlFor(p) {
    var li = p.enriched && p.enriched.linkedin, g = p.enriched && p.enriched.github;
    if (li && li.hasPhoto && p.slug) return API + "/api/photo/" + p.slug + "?v=" + encodeURIComponent(li.importedAt || "");
    return g && g.avatar ? g.avatar : "";
  }
  function avatarHtml(p, size) {
    var u = photoUrlFor(p), st = "width:" + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.4) + "px";
    return u ? '<img class="avatar-img" src="' + esc(u) + '" alt="" style="width:' + size + 'px;height:' + size + 'px" onerror="this.outerHTML=\'<div class=&quot;avatar&quot; style=&quot;' + st + '&quot;>' + esc(initial(p.card.name)) + '</div>\'">' :
      '<div class="avatar" style="' + st + '">' + esc(initial(p.card.name)) + '</div>';
  }
  function linkLabel(k, u) {
    var m = String(u).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    return m.length > 42 ? m.slice(0, 41) + "..." : m;
  }
  /* Profile layout: resume sections from what the owner imported from LinkedIn (Work, Education), then one bordered section per shared link.
     GitHub, X and Instagram are shown as embeds or previews of the real profile, not as copied fields. */
  function handleOf(k, u) {
    var m = String(u || "").replace(/^https?:\/\/(www\.)?/i, "").split(/[?#]/)[0].split("/").filter(Boolean);
    if (k === "x") m = String(u || "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[?#]/)[0].split("/").filter(Boolean), m = m.length ? [m[0]] : [];
    else m = m.slice(1, 2);
    var h = m[0] || "";
    return /^[A-Za-z0-9_.-]{1,40}$/.test(h) ? h : "";
  }
  function enrichHtml(p) {
    var en = p.enriched || {}, li = en.linkedin, c = p.card || { links: {} }, lk = c.links || {};
    function list(x, one) { var a = (x || []).filter(Boolean); if (!a.length && one) a = [one]; return a; }
    function box(title, tag, body, href) {
      return '<section class="linksec"><div class="lshead"><div class="lstitle"><i class="lsdot"></i>' + title + '</div>' +
        (tag ? '<span class="lstag">' + tag + '</span>' : "") + (href ? '<a class="chip" href="' + esc(href) + '" target="_blank" rel="noopener">Open</a>' : "") + '</div>' + (body || "") + '</section>';
    }
    var out = "";
    if (li) {
      var roles = list(li.titles, li.title), cos = list(li.companies, li.company), schools = list(li.schools, li.school);
      if (roles.length || cos.length) out += box("Work", "LinkedIn", roles.map(function (r) { return '<div class="resline">' + esc(r) + '</div>'; }).join("") + cos.map(function (r) { return '<div class="resline sub">' + esc(r) + '</div>'; }).join(""));
      if (schools.length) out += box("Education", "LinkedIn", schools.map(function (r) { return '<div class="resline">' + esc(r) + '</div>'; }).join(""));
    }
    var links = "";
    LINK_DEFS.forEach(function (kd) {
      var k = kd[0], u = lk[k];
      if (!u) return;
      var h = handleOf(k, u), body = "";
      if (k === "github" && h) {
        body = '<a class="ghcard" href="' + esc(u) + '" target="_blank" rel="noopener"><img class="avatar-img" src="https://github.com/' + encodeURIComponent(h) + '.png?size=96" alt="" style="width:48px;height:48px"><div><div style="font-weight:600">' + esc(h) + '</div><div class="lssub">github.com/' + esc(h) + '</div></div></a>';
      } else if (k === "instagram" && h) {
        body = '<iframe class="embedframe" title="Instagram profile" loading="lazy" src="https://www.instagram.com/' + encodeURIComponent(h) + '/embed" height="390" scrolling="no" allowtransparency="true"></iframe>';
      } else if (k === "x" && h) {
        body = '<div class="xembed" data-xh="' + esc(h) + '"></div>';
      }
      links += box(esc(kd[1]), "", body, u);
    });
    return out + links;
  }
  /* X's own timeline widget (platform.twitter.com/widgets.js) renders inside the page; it is only loaded when a profile has an X link. */
  function mountEmbeds() {
    var hs = document.querySelectorAll(".xembed[data-xh]");
    if (!hs.length) return;
    hs.forEach(function (el) {
      var a = document.createElement("a"); a.className = "twitter-timeline"; a.setAttribute("data-height", "460"); a.setAttribute("data-dnt", "true");
      a.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
      a.href = "https://twitter.com/" + encodeURIComponent(el.getAttribute("data-xh")) + "?ref_src=twsrc%5Etfw"; a.textContent = "Posts by @" + el.getAttribute("data-xh");
      el.appendChild(a);
    });
    // X's timeline can fail silently (its endpoint rate-limits and the frame stays empty). If nothing real appears, show a compact card instead of an empty box.
    setTimeout(function () {
      hs.forEach(function (el) {
        var f = el.querySelector("iframe"), ok = f && f.getBoundingClientRect().height > 80;
        if (ok) return;
        var h = el.getAttribute("data-xh");
        el.innerHTML = '<div class="lsline lsmute">X timeline is not available right now.</div><a class="ghcard" href="https://x.com/' + encodeURIComponent(h) + '" target="_blank" rel="noopener"><div><div style="font-weight:600">@' + esc(h) + '</div><div class="lssub">x.com/' + esc(h) + '</div></div></a>';
      });
    }, 9000);
    if (window.twttr && window.twttr.widgets) { window.twttr.widgets.load(); return; }
    var sc = document.createElement("script"); sc.async = true; sc.src = "https://platform.twitter.com/widgets.js"; document.body.appendChild(sc);
  }
  /* Contextual web search: built from shared fields only, sent to Google only when the viewer taps. */
  function searchHtml(p) {
    var li = p.enriched && p.enriched.linkedin, c = p.card, parts = [c.name];
    var ctx = (li && ((li.companies && li.companies[0]) || li.company || (li.schools && li.schools[0]) || li.school)) || (c.headline || "");
    if (ctx) parts.push(ctx);
    var q = parts.join(" ").slice(0, 120);
    return '<section class="linksec"><div class="lshead"><div class="lstitle"><i class="lsdot"></i>Search the web</div></div>' +
      '<input class="input" id="websearch-q" value="' + esc(q) + '" aria-label="Search query">' +
      '<a class="btn btn-accent" id="websearch-go" href="https://www.google.com/search?q=' + encodeURIComponent(q) + '" target="_blank" rel="noopener" style="margin-top:8px">Search Google</a>' +
      '<div class="fineprint" style="margin:8px 0 0">Opens Google. Results may include other people with the same name.</div></section>';
  }
  function renderPerson(id) {
    var people = loadPeople();
    var p = null;
    for (var i = 0; i < people.length; i++) if (people[i].id === id) p = people[i];
    if (!p) { location.hash = "#/people"; return; }
    var me = loadCard();
    var loc = p.location || (p.place ? { lat: p.place.lat, lon: p.place.lng, label: "" } : null);
    var mapLink = loc && loc.lat != null ? mapsUrl(loc) : null;
    shell("people",
      '<div class="profhero">' + avatarHtml(p, 84) +
      '<div class="ph-text"><div class="ph-mark">TAGG</div><h1 class="ph-name">' + esc(p.card.name) + '</h1>' +
      (p.card.headline ? '<div class="ph-head">' + esc(p.card.headline) + '</div>' : '') +
      ((p.enriched && p.enriched.linkedin && p.enriched.linkedin.location) ? '<div class="ph-loc">' + esc(p.enriched.linkedin.location) + '</div>' : '') +
      '</div></div>' +
      '<div class="metagrid">' +
      meta("Met", fmtDate(p.metAt) + " · " + fmtTime(p.metAt)) +
      meta("At", p.event || "-") +
      whereMeta(loc, mapLink) +
      '</div>' +
      '<div class="fineprint" id="cardstate" style="margin:10px 0 4px"></div>' +
      ((p.card.email || p.card.phone) ? '<div class="tc-links" style="margin:6px 0 4px">' + (p.card.email ? '<a class="chip" href="mailto:' + esc(p.card.email) + '">Email</a>' : "") + (p.card.phone ? '<a class="chip" href="tel:' + esc(p.card.phone) + '">Call</a>' : "") + '</div>' : "") +
      (enrichHtml(p) || '<section class="linksec"><div class="lsline lsmute">No links shared</div></section>') +
      searchHtml(p) +
      '<div style="height:12px"></div>' +
      '<button class="btn btn-tinted" id="vcf">Save to Contacts (Apple)</button>' +
      '<h2 class="section">Why keep in touch</h2>' +
      '<div class="answer">' + esc(whyTalk(me, p.card, p.event)) + '</div>' +
      '<h2 class="section">Your note <span class="soon">private to you</span></h2>' +
      '<textarea class="input" id="note" placeholder="What did you two talk about?">' + esc(p.note || "") + '</textarea>' +
      '<div style="height:10px"></div>' +
      '<div class="btnrow">' +
      '<button class="btn btn-gray" id="dictate">' + IC.mic + ' Dictate</button>' +
      '<button class="btn btn-gray" id="savenote">Save note</button>' +
      '</div>' +
      '<h2 class="section">Photo <span class="soon">private to you</span></h2>' +
      '<div id="photozone"></div>' +
      '<h2 class="section">Follow up</h2>' +
      '<button class="btn btn-tinted" id="followup">Ask Tagg to set up a call</button>' +
      '<div style="height:14px"></div>' +
      '<button class="btn btn-plain" id="del" style="color:#ff6961">Remove from Tagg</button>' +
      '<div style="height:110px" aria-hidden="true"></div>'
    );
    mountEmbeds();
    var wq = document.getElementById("websearch-q");
    if (wq) wq.addEventListener("input", function () { document.getElementById("websearch-go").href = "https://www.google.com/search?q=" + encodeURIComponent(wq.value.slice(0, 200)); });
    // Refresh the shared card from the server every time this person is opened. Private notes, place and photo stay yours.
    if (ownerToken() && p.slug) {
      api("/api/people/" + id).then(function (d) {
        if (!d || !d.person) return;
        var cur = location.hash === "#/p/" + id;
        if (!cur) return;
        var changed = JSON.stringify(d.person.card) !== JSON.stringify(p.card) || JSON.stringify(d.person.enriched || null) !== JSON.stringify(p.enriched || null);
        if (d.cardStatus === "live") {
          var st = document.getElementById("cardstate");
          if (st) st.textContent = "Latest shared profile checked just now." + (d.person.card.links && d.person.card.links.linkedin && !(d.person.enriched && d.person.enriched.linkedin) ? " " + d.person.card.name.split(" ")[0] + " has a LinkedIn link but has not added LinkedIn details to Tagg. Tagg only shows details they add and confirm themselves." : "");
          var all = loadPeople(); for (var k = 0; k < all.length; k++) if (all[k].id === id) { all[k].card = d.person.card; all[k].enriched = d.person.enriched || null; }
          savePeople(all);
          if (changed && !(document.activeElement && document.activeElement.id === "note")) renderPerson(id);
        } else if (d.cardStatus === "removed") {
          var hold = document.getElementById("cardstate");
          if (hold) hold.textContent = "This person no longer shares their card. Only their name is kept. Your notes, place and photo are unchanged.";
        }
      }).catch(function () {
        var hold = document.getElementById("cardstate");
        if (hold) hold.textContent = "Showing the copy saved on " + fmtDate(p.metAt) + ". Could not check for updates right now.";
      });
    }
    document.getElementById("vcf").addEventListener("click", function () { downloadVcf(p); });
    document.getElementById("savenote").addEventListener("click", function () {
      p.note = document.getElementById("note").value;
      persistPerson(p, { note: p.note });
      toast("Note saved");
    });
    var delBtn = document.getElementById("del");
    delBtn.addEventListener("click", function () {
      if (delBtn.dataset.armed) {
        savePeople(loadPeople().filter(function (x) { return x.id !== p.id; }));
        if (ownerToken()) api("/api/people/" + p.id, { method: "DELETE" }).catch(function () {});
        location.hash = "#/people";
      } else {
        delBtn.dataset.armed = "1";
        delBtn.textContent = "Tap again to remove";
        setTimeout(function () {
          delBtn.dataset.armed = "";
          delBtn.textContent = "Remove from Tagg";
        }, 3000);
      }
    });
    document.getElementById("followup").addEventListener("click", function () {
      var bg = document.createElement("div");
      bg.className = "sheet-bg";
      var mail = p.card.email ? '<a class="btn btn-accent" href="mailto:' + esc(p.card.email) + "?subject=" + encodeURIComponent("Following up - " + (p.event || "great meeting you")) + '">Email ' + esc(p.card.name.split(" ")[0]) + '</a>' : "";
      var tel = p.card.phone ? '<a class="btn btn-gray" href="tel:' + esc(p.card.phone) + '">Call</a>' : "";
      bg.innerHTML = '<div class="sheet"><div class="grab"></div>' +
        '<h3>Set up a call</h3>' +
        '<p class="hint">Soon, your Tagg agent will talk to ' + esc(p.card.name.split(" ")[0]) + '\'s agent, compare calendars and suggest a time - you both just tap to confirm. Agent-to-agent scheduling is still being built. For now, reach out directly:</p>' +
        (mail || tel ? mail + tel : '<p class="hint">They did not share an email or phone number.</p>') +
        '<button class="btn btn-plain" id="closesheet">Close</button></div>';
      document.body.appendChild(bg);
      bg.addEventListener("click", function (e) { if (e.target === bg) bg.remove(); });
      bg.querySelector("#closesheet").addEventListener("click", function () { bg.remove(); });
    });
    setupDictate(p);
    setupPhoto(p);
  }
  // "Where" tile: nearby place name, city, and free Google Maps / Street View links (plain links, no API key or cost).
  // Street View is only a link to the PLACE - it is never shown as a photo of the person.
  function whereMeta(loc, mapLink) {
    if (!loc || (loc.lat == null && !loc.label && !loc.place)) return "";
    var parts = [];
    var name = [loc.place, loc.label].filter(Boolean).join(" - ");
    if (name) parts.push(esc(name));
    if (loc.lat != null && loc.lon != null) {
      var sv = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + loc.lat + "," + loc.lon;
      parts.push('<span class="linklist"><a href="' + mapLink + '" target="_blank" rel="noopener">Open in Google Maps</a> · <a href="' + sv + '" target="_blank" rel="noopener">Place image</a></span>');
      parts.push('<span style="color:var(--text-2);font-size:12px">' + loc.lat + ", " + loc.lon + (fixNote(loc) ? "<br>" + esc(fixNote(loc)) : "") + '</span>');
    }
    return meta("Where", parts.join("<br>"));
  }
  function meta(k, v) {
    return '<div class="metacard"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }

  /* ================= people list ================= */
  function renderPeople() {
    var people = loadPeople();
    shell("people",
      '<h1 class="largetitle">People</h1>' +
      '<p class="lead">Everyone you have met through Tagg, newest first.</p>' +
      (INBOX.length ? '<h2 class="section" style="margin-top:6px">Connection requests</h2><div class="group">' + INBOX.map(function (r) {
        return '<div class="row"><div class="avatar">' + esc(initial(r.name || "?")) + '</div>' +
          '<div class="grow"><div class="title">' + esc(r.name || "Someone") + '</div>' +
          '<div class="detail" style="white-space:normal">' + esc([r.event || (r.location && r.location.label) || "", fmtDate(r.at)].filter(Boolean).join(" · ")) + (r.contact ? " · " + esc(r.contact) : "") + (r.hasCard ? " · has a Tagg card" : "") + (r.verified ? " · Google-verified" : " · unverified identity") + '</div></div></div>' +
          '<div class="row" style="gap:8px;border-bottom:none;padding-top:0"><button class="btn btn-accent small" data-acc="' + r.id + '" style="flex:1">Connect back</button><button class="btn btn-gray small" data-dec="' + r.id + '" style="flex:1">Not now</button></div>';
      }).join("") + '</div>' : "") +
      (people.length ? '<div class="group">' + people.map(function (p) {
        return '<a class="row" href="#/p/' + p.id + '">' +
          '<div class="avatar">' + esc(initial(p.card.name)) + '</div>' +
          '<div class="grow"><div class="title">' + esc(p.card.name) + '</div>' +
          '<div class="detail">' + esc(p.event || "Somewhere") + " · " + fmtDate(p.metAt) + '</div></div>' +
          IC.chev + '</a>';
      }).join("") + '</div>' :
      '<div class="empty"><div class="glyph">' + IC.people + '</div><div class="t">No one here yet</div><div class="d">Show your Tagg code next time you meet someone - they will appear here with when and where.</div></div>') +
      (people.length ? '<div style="height:14px"></div><a class="btn btn-tinted" href="#/ask">Ask about the people you met</a>' : '<div style="height:14px"></div><a class="btn btn-accent" href="#/">Show my Tagg code</a>')
    );
    Array.prototype.forEach.call(document.querySelectorAll("[data-acc]"), function (b) {
      b.addEventListener("click", function () { respond(b.getAttribute("data-acc"), true, b); });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-dec]"), function (b) {
      b.addEventListener("click", function () { respond(b.getAttribute("data-dec"), false, b); });
    });
    function respond(id, accept, btn) {
      btn.disabled = true; btn.textContent = accept ? "Connecting..." : "Removing...";
      api("/api/inbox/respond", { method: "POST", body: { id: id, accept: accept } }).then(function (d) {
        INBOX = INBOX.filter(function (x) { return x.id !== id; });
        INBOX_COUNT = INBOX.length;
        if (accept && d.personId) {
          lastSync = 0;
          syncPeople().then(function () { momentSheet(d.personId); });
        } else { route(); }
      }).catch(function () {
        toast("Could not reach the database");
        btn.disabled = false; btn.textContent = accept ? "Connect back" : "Not now";
      });
    }
  }

  /* ================= ask ================= */
  var STOP = ("who did i meet at the a an and or of with in on from to that this those these what when where which " +
    "was were is are do does works work working worked about tell me show person people guy girl someone anyone").split(" ");
  var CHAT = [];
  try { CHAT = JSON.parse(sessionStorage.getItem("tagg.chat") || "[]"); } catch (e) { CHAT = []; }
  function saveChat() { try { sessionStorage.setItem("tagg.chat", JSON.stringify(CHAT.slice(-30))); } catch (e) {} }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var CAN_SPEAK = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  var MIC_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  function speak(text) {
    if (!CAN_SPEAK || localStorage.getItem("tagg.speak") !== "1") return;
    try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch (e) {}
  }
  function renderAsk() {
    shell("ask",
      '<h1 class="largetitle">Ask Tagg</h1>' +
      '<p class="lead">Ask about the people you have met - who they are, where and when you met, and who worked or studied somewhere.</p>' +
      '<div class="thread" id="thread" aria-live="polite"></div>' +
      '<div class="composer"><input class="input" id="q" placeholder="Who did I meet at Cal Hacks who works on robotics?" aria-label="Your question">' +
      (SR ? '<button class="btn btn-gray micbtn" id="mic" aria-label="Speak your question" aria-pressed="false">' + MIC_SVG + '</button>' : '') +
      '<button class="btn btn-accent sendbtn" id="go">Ask</button></div>' +
      '<div class="chatopts">' +
      (CAN_SPEAK ? '<label class="chk"><input type="checkbox" id="speak"' + (localStorage.getItem("tagg.speak") === "1" ? " checked" : "") + '> Read answers aloud</label>' : "") +
      (CHAT.length ? '<button class="linkbtn" id="clearchat">Clear conversation</button>' : "") + '</div>' +
      '<p class="footer-note">To answer, Tagg sends the people you saved (names, headlines, where and when you met, enrichment snippets and your private notes) to Cloudflare Workers AI, which also hosts Tagg. Nobody else sees them.' +
      (SR ? ' Voice input uses your browser\'s speech recognition, which may send audio to your browser vendor.' : "") + '</p>'
    );
    var thread = document.getElementById("thread");
    function paint() {
      thread.innerHTML = CHAT.map(function (m) {
        return '<div class="bubble ' + (m.r === "me" ? "me" : "tagg") + '">' + esc(m.t) + (m.links || "") + '</div>';
      }).join("");
      window.scrollTo(0, document.body.scrollHeight);
    }
    paint();
    function go() { if (!document.getElementById("q").value.trim()) return; consentThen("ask", "Ask with Cloudflare AI?",
      "To answer, Tagg sends the people you saved to Cloudflare Workers AI (which also hosts Tagg), including names, headlines, where and when you met, public profile snippets and your private notes. Other Tagg users never see your notes.",
      "Send and ask", go2); }
    function go2() {
      var qi = document.getElementById("q"), q = qi.value.trim();
      if (!q) return;
      qi.value = "";
      var history = CHAT.filter(function (m) { return m.t && m.t !== "Thinking..."; }).slice(-6).map(function (m) { return { r: m.r, t: m.t }; });
      CHAT.push({ r: "me", t: q });
      var pending = { r: "tagg", t: "Thinking..." }; CHAT.push(pending); paint();
      function done(text, links) { pending.t = text; pending.links = links || ""; saveChat(); paint(); speak(text); }
      if (!ownerToken()) { var tmp = document.createElement("div"); tmp.innerHTML = answerHtml(q); return done(tmp.textContent, quickLinks(q)); }
      api("/api/ask", { method: "POST", body: { q: q, history: history } }).then(function (d) {
        var chips = "", seen = {};
        (d.suggestions || []).forEach(function (s) {
          var key = s.heard + ">" + s.meant; if (seen[key]) return; seen[key] = 1;
          var fixed = q.replace(new RegExp("\\b" + s.heard.replace(/[^A-Za-z0-9]/g, "") + "\\b", "i"), s.meant);
          chips += '<button class="btn btn-tinted small sugg" data-q="' + esc(fixed) + '" style="margin:6px 8px 0 0;width:auto">Search ' + esc(s.meant) + ' instead of ' + esc(s.heard) + '</button>';
        });
        done(d.answer, (chips ? '<div class="suggs">' + chips + '</div>' : "") + (d.suggestions ? "" : quickLinks(q)));
      })
        .catch(function (e) {
          if (e && e.error === "ask_failed") return done("Ask is unavailable right now. The free AI allowance may be used up for today. Try again later.", quickLinks(q));
          var tmp2 = document.createElement("div"); tmp2.innerHTML = answerHtml(q); done(tmp2.textContent, quickLinks(q));
        });
    }
    document.getElementById("go").addEventListener("click", go);
    thread.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".sugg") : null; if (!b) return;
      document.getElementById("q").value = b.getAttribute("data-q"); go();
    });
    document.getElementById("q").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    var sp = document.getElementById("speak");
    if (sp) sp.addEventListener("change", function () { localStorage.setItem("tagg.speak", sp.checked ? "1" : "0"); if (!sp.checked) try { window.speechSynthesis.cancel(); } catch (e) {} });
    var cc = document.getElementById("clearchat");
    if (cc) cc.addEventListener("click", function () { CHAT = []; saveChat(); renderAsk(); });
    var mic = document.getElementById("mic");
    if (mic && SR) {
      var rec = null;
      mic.addEventListener("click", function () {
        if (rec) { try { rec.stop(); } catch (e) {} return; }
        rec = new SR(); rec.lang = navigator.language || "en-US"; rec.interimResults = true; rec.continuous = false;
        mic.setAttribute("aria-pressed", "true"); mic.classList.add("live");
        rec.onresult = function (ev) {
          var t = ""; for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
          document.getElementById("q").value = t;
        };
        rec.onerror = function () { toast("Could not hear that. Check microphone permission."); };
        rec.onend = function () { rec = null; mic.setAttribute("aria-pressed", "false"); mic.classList.remove("live"); };
        try { rec.start(); } catch (e) { rec = null; mic.classList.remove("live"); }
      });
    }
  }
  function scorePeople(q) {
    var people = loadPeople();
    var terms = q.toLowerCase().replace(/[?.,!'"]/g, " ").split(/\s+/).filter(function (t) {
      return t && STOP.indexOf(t) < 0;
    });
    var scored = people.map(function (p) {
      var hay = [p.card.name, p.card.headline, p.event, p.note,
        p.location && p.location.label ? p.location.label : ""].join(" ").toLowerCase();
      return { p: p, score: terms.filter(function (t) { return hay.indexOf(t) >= 0; }).length };
    }).filter(function (s) { return terms.length === 0 || s.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored;
  }
  function quickLinks(q) {
    var scored = scorePeople(q);
    if (!scored.length) return "";
    return '<div style="margin-top:12px">' + scored.slice(0, 3).map(function (s) {
      return '<a class="btn btn-gray small" style="margin-right:8px;margin-bottom:8px" href="#/p/' + s.p.id + '">' + esc(s.p.card.name) + '</a>';
    }).join("") + '</div>';
  }
  function answerHtml(q) {
    var people = loadPeople();
    if (!people.length) {
      return '<div class="empty"><div class="glyph">' + IC.ask + '</div><div class="t">Nothing to search yet</div><div class="d">Once you meet people through Tagg, ask things like "Who did I meet at Cal Hacks?"</div></div>';
    }
    var me = loadCard();
    var scored = scorePeople(q);
    if (!scored.length) {
      return '<div class="answer">I do not have anyone saved who matches that yet. Try a name, an event, or a topic like "robotics".</div>';
    }
    return scored.slice(0, 4).map(function (s) {
      var p = s.p;
      return '<div class="answer" style="margin-bottom:12px">' +
        'You met <b>' + esc(p.card.name) + '</b>' +
        (p.event ? ' at <b>' + esc(p.event) + '</b>' : '') +
        ' on ' + fmtDate(p.metAt) + ' at ' + fmtTime(p.metAt) + '.' +
        (p.card.headline ? ' ' + esc(p.card.headline) + '.' : '') +
        '<br><span style="color:var(--text-2)">' + esc(whyTalk(me, p.card, p.event)) + '</span>' +
        (p.note ? '<br><span style="color:var(--text-2)">Your note: ' + esc(p.note) + '</span>' : '') +
        '<div style="margin-top:10px"><a class="btn btn-gray small" href="#/p/' + p.id + '">Open card</a></div>' +
        '</div>';
    }).join("");
  }

  /* ================= map (connections view) ================= */
  function renderMap() {
    var people = loadPeople();
    shell("map",
      '<h1 class="largetitle">Your map</h1>' +
      '<p class="lead">Everyone you have met. Drag a person to move them, drag the background to pan, pinch or scroll to zoom, tap to open a card. Orange lines join people you met at the same event.</p>' +
      (people.length ?
        '<div class="graphwrap" style="position:relative"><canvas id="graph"></canvas>' +
        '<div class="graphctl"><button id="g-in" aria-label="Zoom in">+</button><button id="g-out" aria-label="Zoom out">\u2212</button><button id="g-reset" aria-label="Reset view">Reset</button></div></div>' +
        '<p class="hint" style="text-align:center;margin-top:10px">' + people.length + ' connection' + (people.length > 1 ? "s" : "") + ' so far</p>'
      : '<div class="empty"><div class="glyph">' + IC.map + '</div><div class="t">Nothing to map yet</div><div class="d">Meet people through Tagg and your constellation appears here.</div></div>')
    );
    if (!people.length) return;
    // Interactive graph: nodes settle with a small physics model. Drag a node to move it, drag the background to pan,
    // pinch / scroll / +- to zoom. People who met at the same event are linked. Tap a node (without dragging) to open it.
    var cv = document.getElementById("graph");
    var W = cv.parentElement.clientWidth - 20, H = Math.min(520, Math.max(340, Math.round(W * 1.15)));
    var dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px"; cv.style.touchAction = "none"; cv.style.cursor = "grab";
    var g = cv.getContext("2d");
    var font = getComputedStyle(document.body).fontFamily;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var cs = getComputedStyle(document.documentElement);
    var mapLine = cs.getPropertyValue("--map-line").trim(), mapNode = cs.getPropertyValue("--map-node").trim(), mapText = cs.getPropertyValue("--map-text").trim(), mapSub = cs.getPropertyValue("--text-2").trim();
    var me = loadCard();
    var R0 = Math.min(W, H) / 2 - 56;
    var nodes = [{ you: true, x: 0, y: 0, vx: 0, vy: 0, r: 26, label: "You", init: me ? initial(me.name) : "Y", fixed: false }];
    people.forEach(function (p, i) {
      var a = -Math.PI / 2 + (2 * Math.PI * i) / people.length;
      nodes.push({ p: p, x: R0 * Math.cos(a), y: R0 * Math.sin(a), vx: 0, vy: 0, r: 20, init: initial(p.card.name), label: (function (n) { return n.length > 10 ? n.slice(0, 9) + "\u2026" : n; })(p.card.name.split(" ")[0]) });
    });
    var links = [];
    for (var i = 1; i < nodes.length; i++) links.push({ a: 0, b: i, k: 0.02, len: R0 * 0.75, soft: false });
    for (var i = 1; i < nodes.length; i++) for (var j = i + 1; j < nodes.length; j++) {
      var ea = (nodes[i].p.event || "").trim().toLowerCase(), eb = (nodes[j].p.event || "").trim().toLowerCase();
      if (ea && ea === eb) links.push({ a: i, b: j, k: 0.012, len: 70, soft: true });
    }
    var view = { x: W / 2, y: H / 2, k: 1 };
    var energy = 1, raf = 0, drag = null, pan = null, pinch = null, moved = false;
    function step() {
      var n = nodes.length, e = 0;
      for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
        var A = nodes[i], B = nodes[j], dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
        var f = 2600 / d2, fx = dx / d * f, fy = dy / d * f;
        A.vx -= fx; A.vy -= fy; B.vx += fx; B.vy += fy;
      }
      links.forEach(function (l) {
        var A = nodes[l.a], B = nodes[l.b], dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - l.len) * l.k;
        A.vx += dx / d * f; A.vy += dy / d * f; B.vx -= dx / d * f; B.vy -= dy / d * f;
      });
      nodes.forEach(function (nd) {
        nd.vx -= nd.x * 0.002; nd.vy -= nd.y * 0.002;
        if (nd === drag) { nd.vx = 0; nd.vy = 0; return; }
        nd.vx *= 0.82; nd.vy *= 0.82; nd.x += nd.vx; nd.y += nd.vy; e += nd.vx * nd.vx + nd.vy * nd.vy;
      });
      return e;
    }
    function toWorld(px, py) { return { x: (px - view.x) / view.k, y: (py - view.y) / view.k }; }
    function draw() {
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      g.save(); g.translate(view.x, view.y); g.scale(view.k, view.k);
      links.forEach(function (l) {
        var A = nodes[l.a], B = nodes[l.b]; g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y);
        g.strokeStyle = l.soft ? "rgba(217,115,61,0.55)" : mapLine; g.lineWidth = (l.soft ? 1.6 : 1) / view.k; g.stroke();
      });
      nodes.forEach(function (n) {
        g.beginPath(); g.arc(n.x, n.y, n.r, 0, 7);
        if (n.you) { var grd = g.createLinearGradient(n.x - 24, n.y - 24, n.x + 24, n.y + 24); grd.addColorStop(0, "#d9733d"); grd.addColorStop(1, "#e5954f"); g.fillStyle = grd; }
        else g.fillStyle = mapNode;
        g.fill(); if (!n.you) { g.strokeStyle = mapLine; g.lineWidth = 1 / view.k; g.stroke(); }
        g.fillStyle = n.you ? "#fff" : mapText; g.font = (n.you ? "700 15px " : "600 13px ") + font; g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(n.init, n.x, n.y);
        g.fillStyle = mapSub; g.font = "11px " + font; g.fillText(n.label, n.x, n.y + n.r + 12);
      });
      g.restore();
    }
    function loop() {
      raf = 0;
      if (!document.body.contains(cv)) return;           // left the Map screen: stop
      energy = step(); draw();
      if (energy > 0.02 || drag) raf = requestAnimationFrame(loop);
    }
    function kick() { if (reduce) { for (var i = 0; i < 4; i++) step(); draw(); } else if (!raf) raf = requestAnimationFrame(loop); }
    if (reduce) { for (var i = 0; i < 300; i++) step(); draw(); }   // reduced motion: settle once, no animation
    else { for (var i = 0; i < 60; i++) step(); raf = requestAnimationFrame(loop); }
    function hit(px, py) {
      var w = toWorld(px, py);
      for (var i = nodes.length - 1; i >= 0; i--) { var n = nodes[i], r = n.r + 8 / view.k; if ((w.x - n.x) * (w.x - n.x) + (w.y - n.y) * (w.y - n.y) < r * r) return n; }
      return null;
    }
    function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    var pts = {};
    function zoomAt(px, py, f) {
      var nk = Math.max(0.4, Math.min(3.5, view.k * f)), w = toWorld(px, py);
      view.k = nk; view.x = px - w.x * nk; view.y = py - w.y * nk; draw();
    }
    cv.addEventListener("pointerdown", function (e) {
      cv.setPointerCapture(e.pointerId); var p = pos(e); pts[e.pointerId] = p; moved = false;
      var ids = Object.keys(pts);
      if (ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }; drag = null; pan = null; return; }
      var n = hit(p.x, p.y);
      if (n) { drag = n; cv.style.cursor = "grabbing"; kick(); } else { pan = { x: p.x, y: p.y, vx: view.x, vy: view.y }; cv.style.cursor = "grabbing"; }
    });
    cv.addEventListener("pointermove", function (e) {
      var p = pos(e);
      if (!pts[e.pointerId]) { cv.style.cursor = hit(p.x, p.y) ? "pointer" : "grab"; return; }
      pts[e.pointerId] = p;
      var ids = Object.keys(pts);
      if (pinch && ids.length === 2) {
        var a = pts[ids[0]], b = pts[ids[1]], d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * d / pinch.d) / view.k); moved = true; return;
      }
      if (drag) { var w = toWorld(p.x, p.y); if (Math.abs(w.x - drag.x) + Math.abs(w.y - drag.y) > 3) moved = true; drag.x = w.x; drag.y = w.y; drag.vx = drag.vy = 0; kick(); if (reduce) draw(); }
      else if (pan) { if (Math.abs(p.x - pan.x) + Math.abs(p.y - pan.y) > 4) moved = true; view.x = pan.vx + p.x - pan.x; view.y = pan.vy + p.y - pan.y; draw(); }
    });
    function up(e) {
      var wasDrag = drag; delete pts[e.pointerId]; if (Object.keys(pts).length < 2) pinch = null;
      cv.style.cursor = "grab";
      if (wasDrag && !moved && wasDrag.p) { drag = null; location.hash = "#/p/" + wasDrag.p.id; return; }
      drag = null; pan = null; kick();
    }
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", function (e) { e.preventDefault(); var p = pos(e); zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    function bind(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener("click", fn); }
    bind("g-in", function () { zoomAt(W / 2, H / 2, 1.25); });
    bind("g-out", function () { zoomAt(W / 2, H / 2, 1 / 1.25); });
    bind("g-reset", function () { view = { x: W / 2, y: H / 2, k: 1 }; draw(); });
    cv.tagg = { screen: function (i) { return { x: nodes[i].x * view.k + view.x, y: nodes[i].y * view.k + view.y }; } };
    cv.setAttribute("role", "img"); cv.setAttribute("aria-label", "Network of the " + people.length + " people you have met. Drag to move, pinch or scroll to zoom.");
  }

  /* ================= shared bits: moment sheet, dictate, photo ================= */
  function momentSheet(personId) {
    var people = loadPeople();
    var p = null;
    for (var i = 0; i < people.length; i++) if (people[i].id === personId) p = people[i];
    if (!p) { route(); return; }
    var bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet"><div class="grab"></div>' +
      '<h3>Save the moment</h3>' +
      '<p class="hint">You met ' + esc(p.card.name.split(" ")[0]) + " on " + fmtDate(p.metAt) + " at " + fmtTime(p.metAt) + '. Jot it down while it is fresh.</p>' +
      '<div class="field"><label>Where / what event</label><input class="input" id="m-event" value="' + esc(p.event || "") + '" placeholder="Cal Hacks, Berkeley"></div>' +
      '<div class="field"><label>Note</label><textarea class="input" id="m-note" placeholder="What did you two talk about?">' + esc(p.note || "") + '</textarea></div>' +
      '<button class="btn btn-accent" id="m-save">Save the moment</button>' +
      '<button class="btn btn-plain" id="m-skip">Skip for now</button></div>';
    document.body.appendChild(bg);
    bg.querySelector("#m-skip").addEventListener("click", function () { bg.remove(); location.hash = "#/p/" + personId; });
    bg.querySelector("#m-save").addEventListener("click", function () {
      var b = this; b.disabled = true; b.textContent = "Saving...";
      p.event = document.getElementById("m-event").value.trim();
      p.note = document.getElementById("m-note").value;
      persistPerson(p, { note: p.note, event: p.event });
      bg.remove();
      toast("Moment saved");
      location.hash = "#/p/" + personId;
    });
  }
  function persistPerson(p, fields) {
    var ps = loadPeople();
    for (var i = 0; i < ps.length; i++) if (ps[i].id === p.id) ps[i] = p;
    savePeople(ps);
    if (ownerToken()) api("/api/people/" + p.id, { method: "PUT", body: fields })
      .catch(function () { toast("Saved on this device only - database unreachable"); });
  }
  // Voice-to-text using the browser's built-in speech recognition (free, on-device or
  // via the browser vendor). Works for any button + textarea pair; hides itself if unsupported.
  function setupDictate(p, btnId, taId) {
    var btn = document.getElementById(btnId || "dictate");
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.style.display = "none"; return; }
    var rec = null, active = false;
    btn.addEventListener("click", function () {
      if (active) { try { rec.stop(); } catch (e) {} return; }
      rec = new SR();
      rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      var ta = document.getElementById(taId || "note");
      var base = ta.value;
      rec.onresult = function (e) {
        var interim = "", fin = "";
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) fin += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        if (fin) base = (base ? base.replace(/\s+$/, "") + " " : "") + fin.trim();
        ta.value = base + (interim ? (base ? " " : "") + interim : "");
      };
      rec.onend = function () {
        active = false;
        btn.innerHTML = IC.mic + ' Dictate';
        btn.classList.remove("btn-accent"); btn.classList.add("btn-gray");
      };
      rec.onerror = function (e) { if (e.error === "not-allowed") toast("Microphone permission denied"); };
      active = true;
      btn.textContent = "Listening - tap to stop";
      btn.classList.remove("btn-gray"); btn.classList.add("btn-accent");
      try { rec.start(); } catch (e) { active = false; }
    });
  }
  function setupPhoto(p) {
    var zone = document.getElementById("photozone");
    function render() {
      zone.innerHTML =
        (p.photo ? '<img src="' + p.photo + '" alt="Your photo together" id="photoview" style="width:100%;border-radius:12px;display:block;cursor:pointer"><div style="height:10px"></div>' : "") +
        '<button class="btn btn-gray" id="addphoto">' + (p.photo ? "Replace photo" : "Add a selfie from the moment") + '</button>' +
        '<input type="file" id="photofile" accept="image/*" capture="user" style="display:none">';
      document.getElementById("addphoto").addEventListener("click", function () { document.getElementById("photofile").click(); });
      document.getElementById("photofile").addEventListener("change", onFile);
      var pv = document.getElementById("photoview");
      if (pv) pv.addEventListener("click", function () {
        var bg = document.createElement("div");
        bg.className = "sheet-bg";
        bg.innerHTML = '<div class="sheet" style="padding:10px 10px calc(env(safe-area-inset-bottom, 0px) + 12px)"><img src="' + p.photo + '" style="width:100%;border-radius:16px;display:block">' +
          '<div style="height:10px"></div><button class="btn btn-gray" id="closepv">Close</button>' +
          '<button class="btn btn-plain" id="delpv" style="color:#ff6961">Remove photo</button></div>';
        document.body.appendChild(bg);
        bg.addEventListener("click", function (e) { if (e.target === bg) bg.remove(); });
        bg.querySelector("#closepv").addEventListener("click", function () { bg.remove(); });
        bg.querySelector("#delpv").addEventListener("click", function () {
          delete p.photo;
          persistPerson(p, { photo: "" });
          bg.remove(); render();
          toast("Photo removed");
        });
      });
    }
    function onFile(e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var img = new Image();
      img.onload = function () {
        var max = 720;
        var s = Math.min(1, max / Math.max(img.width, img.height));
        var cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(img.width * s));
        cv.height = Math.max(1, Math.round(img.height * s));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        var url = cv.toDataURL("image/jpeg", 0.8);
        URL.revokeObjectURL(img.src);
        p.photo = url;
        persistPerson(p, { photo: url });
        render();
        toast("Photo saved");
      };
      img.onerror = function () { toast("Could not read that image"); };
      img.src = URL.createObjectURL(f);
    }
    render();
  }

  /* PWA install prompt */
  var deferredInstall = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredInstall = e;
    route();
  });
  function isIosUninstalled() {
    var ua = navigator.userAgent.toLowerCase();
    var ios = /iphone|ipad|ipod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    return ios && !window.navigator.standalone &&
      !(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  }

  startLive();
  route();
  if (loadCard() || loadPeople().length || ownerToken()) {
    ensureOwner()
      .then(function () { return syncCard(); })
      .then(function () { return migrateOnce(); })
      .then(function () { lastSync = 0; refreshSoon(); });
  }
})();
