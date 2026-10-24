/* Tagg - people memory with a personal agent. Client-side MVP. */
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
  var API = "https://tagg-api.prajval-2029.workers.dev";
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
  function googleSignIn(credential) {
    return api("/api/auth/google", { method: "POST", body: { credential: credential, deviceToken: ownerToken() } })
      .then(function (d) {
        setOwnerToken(d.ownerToken);
        setProfile(d.profile);
        lastSync = 0;
        return syncPeople().then(function () {
          toast("Signed in as " + (d.profile.email || "you") + " - your Tagg is backed up");
          route();
        });
      }).catch(function () { toast("Sign-in failed - your data is still safe on this device"); });
  }
  function mountGoogleButton(el) {
    if (!window.google || !google.accounts || !google.accounts.id) { el.innerHTML = '<p class="hint">Google sign-in is still loading - pull to retry.</p>'; return; }
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: function (resp) { googleSignIn(resp.credential); } });
    google.accounts.id.renderButton(el, { theme: "filled_black", size: "large", shape: "pill", text: "signin_with", width: 300 });
  }
  var lastSync = 0, syncing = false, INBOX = [], INBOX_COUNT = 0;
  function refreshSoon(force) {
    if (syncing || (!force && Date.now() - lastSync < 10000)) return;
    syncing = true; lastSync = Date.now();
    syncPeople().then(function () {
      if (!ownerToken()) return;
      return api("/api/inbox").then(function (d) {
        INBOX = d.requests || []; INBOX_COUNT = INBOX.length;
      }).catch(function () {});
    }).then(function () { syncing = false; route(); }, function () { syncing = false; });
  }
  /* location with a human-readable place label */
  function withLocation(cb) {
    function done(v) { clearTimeout(timer); cb(v); }
    var timer = setTimeout(function () { cb(null); }, 4500);
    if (!navigator.geolocation) { clearTimeout(timer); return cb(null); }
    navigator.geolocation.getCurrentPosition(function (pos) {
      var loc = { lat: +pos.coords.latitude.toFixed(5), lon: +pos.coords.longitude.toFixed(5), label: "" };
      fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=" + loc.lat + "&lon=" + loc.lon)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var a = d.address || {};
          loc.label = [a.city || a.town || a.village || a.suburb || a.county || "", a.state || ""].filter(Boolean).join(", ") || (d.display_name || "").split(",").slice(0, 2).join(",");
          done(loc);
        }).catch(function () { done(loc); });
    }, function () { done(null); }, { timeout: 2500, maximumAge: 300000 });
  }

  /* ================= card payload (QR) ================= */
  function cardUrl(c) {
    var slug = cardSlug();
    if (slug) return location.origin + location.pathname + "#/c/" + slug;
    var payload = { v: 1, n: c.name, h: c.headline || "" };
    if (c.email) payload.e = c.email;
    if (c.phone) payload.p = c.phone;
    var l = {};
    ["linkedin", "github", "x", "instagram", "website"].forEach(function (k) {
      if (c.links && c.links[k]) l[k] = c.links[k];
    });
    if (Object.keys(l).length) payload.l = l;
    var json = JSON.stringify(payload);
    var b64 = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return location.origin + location.pathname + "#/c/" + b64;
  }
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
    qr: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z"/></svg>',
    mic: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    chev: '<svg class="chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>'
  };

  /* ================= routing ================= */
  var app = document.getElementById("app");
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
    if (h === "#/map") { refreshSoon(); return renderMap(); }
    refreshSoon();
    return renderHome();
  }
  window.addEventListener("hashchange", route);

  function shell(active, inner) {
    var card = loadCard();
    app.innerHTML =
      '<div class="topbar"><div class="wordmark"><span class="mark">T</span>Tagg</div>' +
      '<div class="sub">Meet once. Tagg remembers.</div></div>' +
      '<div class="content">' + inner + '</div>' +
      (card ? tabbarHtml(active) : "");
  }
  function tabbarHtml(active) {
    function tab(id, href, icon, label) {
      var badge = (id === "people" && INBOX_COUNT) ? '<span class="tabbadge"></span>' : "";
      return '<a class="tab' + (active === id ? " active" : "") + '" href="' + href + '">' + icon + badge + '<span>' + label + '</span></a>';
    }
    return '<nav class="tabbar">' +
      tab("card", "#/", IC.card, "My Card") +
      tab("people", "#/people", IC.people, "People") +
      tab("map", "#/map", IC.map, "Map") +
      tab("ask", "#/ask", IC.ask, "Ask") +
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
      (profile()
        ? '<div class="group"><div class="row"><div class="grow"><div class="detail" style="white-space:normal">Signed in as <b>' + esc(profile().email) + '</b> - your card and people are backed up to your Tagg account.</div></div></div></div>'
        : '<h2 class="section">Back up and sync</h2><div id="gsign"></div><p class="hint" style="margin-top:8px">Sign in so your card and the people you meet survive a new phone or a cleared browser.</p>') +
      (INBOX_COUNT ? '<h2 class="section">Requests</h2><a class="group" style="display:block;text-decoration:none;color:inherit" href="#/people"><div class="row"><div class="avatar" style="background:var(--card-2);color:var(--accent-2)">' + IC.people + '</div><div class="grow"><div class="title">' + INBOX_COUNT + ' connection request' + (INBOX_COUNT > 1 ? "s" : "") + '</div><div class="detail">Tap to connect back and save the moment</div></div>' + IC.chev + '</div></a>' : "") +
      '<h2 class="section">Recently met</h2>' +
      (people.length ? recentHtml(people) :
        '<div class="group"><div class="row"><div class="grow"><div class="detail" style="white-space:normal">No one saved yet. When someone scans your code and saves you - or you scan theirs - they show up here.</div></div></div></div>') +
      '<p class="footer-note">Your card and the people you meet live in your own Tagg database - synced, backed up, and always recallable.<br>Tagg is live at ' + esc(location.host) + '.</p>'
    );
    document.getElementById("copylink").addEventListener("click", function () {
      (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
        .then(function () { toast("Link copied"); }, function () { toast("Copy failed - long-press the QR page URL"); });
    });
    document.getElementById("wallet").addEventListener("click", function () {
      var btn = this; btn.disabled = true; btn.textContent = "Making your Wallet pass...";
      api("/api/pass", { method: "POST", body: {} }).then(function (d) {
        btn.disabled = false; btn.textContent = "Add to Apple Wallet";
        window.location.href = d.download_url;
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = "Add to Apple Wallet";
        toast((e && e.error) || "Wallet pass unavailable - your QR does the same job");
      });
    });
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
      '<p class="footer-note">Everything stays on your device in this early version.</p>'
    );
    function feat(t, d) {
      return '<div class="row"><div class="grow"><div class="title">' + t + '</div><div class="detail" style="white-space:normal">' + d + '</div></div></div>';
    }
  }

  function renderEdit() {
    var c = loadCard() || { name: "", headline: "", email: "", phone: "", links: {} };
    shell(null,
      '<h1 class="largetitle">' + (loadCard() ? "Edit card" : "Your card") + '</h1>' +
      '<p class="lead">This is what people see when they scan your code.</p>' +
      '<div class="field"><label>Name</label><input class="input" id="f-name" placeholder="Prajval Arora" value="' + esc(c.name) + '"></div>' +
      '<div class="field"><label>Headline</label><input class="input" id="f-head" placeholder="Robotics engineering at ASU" value="' + esc(c.headline) + '"></div>' +
      '<div class="field"><label>LinkedIn</label><input class="input" id="f-linkedin" placeholder="username or URL" value="' + esc(c.links.linkedin || "") + '"></div>' +
      '<div class="field"><label>GitHub</label><input class="input" id="f-github" placeholder="username or URL" value="' + esc(c.links.github || "") + '"></div>' +
      '<div class="field"><label>X</label><input class="input" id="f-x" placeholder="handle" value="' + esc(c.links.x || "") + '"></div>' +
      '<div class="field"><label>Instagram</label><input class="input" id="f-instagram" placeholder="handle" value="' + esc(c.links.instagram || "") + '"></div>' +
      '<div class="field"><label>Website</label><input class="input" id="f-website" placeholder="prajvalarora.com" value="' + esc(c.links.website || "") + '"></div>' +
      '<div class="field"><label>Email</label><input class="input" id="f-email" type="email" placeholder="you@example.com" value="' + esc(c.email) + '"></div>' +
      '<div class="field"><label>Phone</label><input class="input" id="f-phone" type="tel" placeholder="+1 ..." value="' + esc(c.phone) + '"></div>' +
      '<h2 class="section">Preview</h2>' +
      '<div id="preview"></div>' +
      '<div style="height:18px"></div>' +
      '<button class="btn btn-accent" id="save">Save card</button>'
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
    document.getElementById("save").addEventListener("click", function () {
      var c = collect();
      if (!c.name) { toast("Add your name first"); return; }
      Object.keys(c.links).forEach(function (k) { if (!c.links[k]) delete c.links[k]; });
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
      api("/api/c/" + id).then(function (d) { renderScanned(d.card, id, d.enriched); }).catch(function () {
        shell(null, '<div class="empty"><div class="t">That code did not scan right</div><div class="d">Ask them to show their Tagg code again.</div></div><a class="btn btn-gray" href="#/">Back</a>');
      });
      return;
    }
    renderScanned(decodePayload(id), null, null);
  }
  function renderScanned(c, slug, enriched) {
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
    shell(null,
      '<span class="pill">You just met</span>' +
      '<h1 class="largetitle">' + esc(c.name) + '</h1>' +
      '<p class="lead">Share your contact - ' + first + ' gets a notification, and once they connect back you both save the moment.</p>' +
      cardHtml(c) +
      '<div style="height:18px"></div>' +
      '<div id="connectzone">' +
      (mine ? '' :
        '<div class="field"><label>Your name</label><input class="input" id="f-name" placeholder="Your name"></div>' +
        '<div class="field"><label>How to reach you <span style="text-transform:none;color:var(--text-3);font-weight:400">(email, phone, or a handle)</span></label><input class="input" id="f-contact" placeholder="you@example.com"></div>') +
      '<div class="field"><label>Where are you two? (event or place)</label><input class="input" id="f-event" placeholder="Cal Hacks, Berkeley"></div>' +
      '<button class="btn btn-accent" id="connect">Share my contact with ' + first + '</button>' +
      '<p class="hint" style="margin-top:10px;text-align:center">' + (mine ? 'Your Tagg card goes with it automatically.' : 'No account needed - you choose exactly what to share.') + '</p>' +
      '</div>' +
      '<p class="footer-note">Nothing is sent until you tap the button.</p>'
    );
    document.getElementById("connect").addEventListener("click", function () {
      var btn = this;
      var name = mine ? mine.name : document.getElementById("f-name").value.trim();
      var contact = mine ? (mine.email || mine.phone || "") : document.getElementById("f-contact").value.trim();
      var eventName = document.getElementById("f-event").value.trim();
      if (!name) { toast("Add your name first"); return; }
      btn.disabled = true; btn.textContent = "Sharing...";
      withLocation(function (loc) {
        ensureOwner().then(function () {
          return api("/api/connect", { method: "POST", body: {
            slug: slug, name: name, contact: contact, event: eventName, location: loc, requesterToken: ownerToken() } });
        }).then(function (d) {
          setOwnerToken(d.requestToken);
          sentState(d.requestId);
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = "Share my contact with " + first;
          toast((e && e.error) || "Could not reach the database - try again");
        });
      });
    });
    function sentState(requestId) {
      document.getElementById("connectzone").innerHTML =
        '<div class="group"><div class="row"><div class="grow">' +
        '<div class="title">Shared with ' + esc(c.name) + '</div>' +
        '<div class="detail" style="white-space:normal" id="cstatus">They are notified now. When they connect back, you are in each other\'s Tagg.</div>' +
        '</div></div></div>' +
        '<div style="height:18px"></div>' +
        '<h2 class="section" style="margin-top:0">Want this for yourself?</h2>' +
        '<p class="hint">Your own QR, your own people memory - free, 30 seconds.</p>' +
        (mine
          ? '<a class="btn btn-tinted" href="#/">Open my dashboard</a>'
          : '<a class="btn btn-tinted" href="#/edit">Make my Tagg</a>');
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
  function enrichHtml(p) {
    var li = p.enriched && p.enriched.linkedin;
    var liHtml = li ?
      '<h2 class="section">From their public LinkedIn</h2>' +
      '<div class="taggcard"><div style="display:flex;gap:14px;align-items:center">' +
      (li.avatar ? '<img src="' + esc(li.avatar) + '" alt="" style="width:52px;height:52px;border-radius:50%">' : "") +
      '<div>' + (li.headline ? '<div style="font-weight:600">' + esc(li.headline) + '</div>' : "") +
      '<div style="color:var(--text-2);font-size:13px;margin-top:4px">' +
      [li.company, li.school, li.location].filter(Boolean).map(esc).join(" · ") + '</div>' +
      (li.summary ? '<div style="color:var(--text-2);font-size:13px;margin-top:6px">' + esc(li.summary.slice(0, 220)) + (li.summary.length > 220 ? "..." : "") + '</div>' : "") +
      '</div></div></div>' : "";
    var g = p.enriched && p.enriched.github;
    var gHtml = g ?
      '<h2 class="section">From their public GitHub</h2>' +
      '<div class="taggcard"><div style="display:flex;gap:14px;align-items:center">' +
      (g.avatar ? '<img src="' + esc(g.avatar) + '" alt="" style="width:52px;height:52px;border-radius:50%">' : "") +
      '<div><div style="font-weight:600">' + esc(g.name || g.login) + '</div>' +
      (g.bio ? '<div style="color:var(--text-2);font-size:14px;margin-top:2px">' + esc(g.bio) + '</div>' : "") +
      '<div style="color:var(--text-2);font-size:13px;margin-top:4px">' +
      (g.followers != null ? g.followers + " followers" : "") + (g.repos != null ? " · " + g.repos + " public repos" : "") +
      (g.location ? " · " + esc(g.location) : "") + '</div>' +
      '</div></div></div>' : "";
    return liHtml + gHtml;
  }
  function renderPerson(id) {
    var people = loadPeople();
    var p = null;
    for (var i = 0; i < people.length; i++) if (people[i].id === id) p = people[i];
    if (!p) { location.hash = "#/people"; return; }
    var me = loadCard();
    var loc = p.location || (p.place ? { lat: p.place.lat, lon: p.place.lng, label: "" } : null);
    var mapLink = loc && loc.lat != null ? "https://www.google.com/maps?q=" + loc.lat + "," + loc.lon : null;
    shell("people",
      '<div style="display:flex;align-items:center;gap:16px;margin:6px 0 14px">' +
      '<div class="avatar" style="width:60px;height:60px;font-size:24px">' + esc(initial(p.card.name)) + '</div>' +
      '<div><h1 class="largetitle" style="font-size:26px;margin:0">' + esc(p.card.name) + '</h1>' +
      (p.card.headline ? '<div style="color:var(--text-2);font-size:14px;margin-top:2px">' + esc(p.card.headline) + '</div>' : '') +
      '</div></div>' +
      '<div class="metagrid">' +
      meta("Met", fmtDate(p.metAt) + " · " + fmtTime(p.metAt)) +
      meta("At", p.event || "-") +
      (loc && loc.label ? meta("Where", esc(loc.label) + (mapLink ? ' · <span class="linklist"><a href="' + mapLink + '" target="_blank" rel="noopener">map</a></span>' : "")) : (mapLink ? meta("Where", '<span class="linklist"><a href="' + mapLink + '" target="_blank" rel="noopener">Open map</a></span>') : "")) +
      '</div>' +
      '<h2 class="section">Links</h2>' +
      '<div class="taggcard"><div class="tc-links" style="margin-top:0">' + (chipsHtml(p.card) || '<span style="color:var(--text-2);font-size:14px">No links shared</span>') + '</div></div>' +
      enrichHtml(p) +
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
      '<button class="btn btn-plain" id="del" style="color:#ff6961">Remove from Tagg</button>'
    );
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
          '<div class="detail" style="white-space:normal">' + esc([r.event || (r.location && r.location.label) || "", fmtDate(r.at)].filter(Boolean).join(" · ")) + (r.contact ? " · " + esc(r.contact) : "") + (r.hasCard ? " · has a Tagg card" : "") + '</div></div></div>' +
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
  function renderAsk() {
    shell("ask",
      '<h1 class="largetitle">Ask Tagg</h1>' +
      '<p class="lead">Ask about the people you have met - who they are, where and when you met, and why you might talk again.</p>' +
      '<div class="field"><input class="input" id="q" placeholder="Who did I meet at Cal Hacks who works on robotics?" style="border-radius:14px"></div>' +
      '<div style="height:12px"></div>' +
      '<button class="btn btn-accent" id="go">Ask</button>' +
      '<div id="ans" style="margin-top:18px"></div>' +
      '<p class="footer-note">Answers are read from the people saved in your Tagg by an AI model.<br>Nothing is shared with anyone but you.</p>'
    );
    function go() {
      var q = document.getElementById("q").value.trim();
      if (!q) return;
      var ans = document.getElementById("ans");
      if (!ownerToken()) { ans.innerHTML = answerHtml(q); return; }
      ans.innerHTML = '<div class="answer">Thinking...</div>';
      api("/api/ask", { method: "POST", body: { q: q } }).then(function (d) {
        ans.innerHTML = '<div class="answer">' + esc(d.answer) + '</div>' + quickLinks(q);
      }).catch(function () {
        ans.innerHTML = answerHtml(q);
      });
    }
    document.getElementById("go").addEventListener("click", go);
    document.getElementById("q").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
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
      '<p class="lead">Everyone you have met, around you. Tap a node to open their card.</p>' +
      (people.length ?
        '<div class="graphwrap"><canvas id="graph"></canvas></div>' +
        '<p class="hint" style="text-align:center;margin-top:10px">' + people.length + ' connection' + (people.length > 1 ? "s" : "") + ' so far</p>'
      : '<div class="empty"><div class="glyph">' + IC.map + '</div><div class="t">Nothing to map yet</div><div class="d">Meet people through Tagg and your constellation appears here.</div></div>')
    );
    if (!people.length) return;
    var cv = document.getElementById("graph");
    var W = cv.parentElement.clientWidth - 20, H = Math.min(430, Math.max(300, W));
    var dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    var g = cv.getContext("2d"); g.scale(dpr, dpr);
    var font = getComputedStyle(document.body).fontFamily;
    var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 48;
    var nodes = people.map(function (p, i) {
      var a = -Math.PI / 2 + (2 * Math.PI * i) / people.length;
      return { p: p, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
    });
    g.strokeStyle = "rgba(255,255,255,0.14)"; g.lineWidth = 1;
    nodes.forEach(function (n) { g.beginPath(); g.moveTo(cx, cy); g.lineTo(n.x, n.y); g.stroke(); });
    nodes.forEach(function (n) {
      g.beginPath(); g.arc(n.x, n.y, 20, 0, 7); g.fillStyle = "#2c2c2e"; g.fill();
      g.strokeStyle = "rgba(255,255,255,0.18)"; g.stroke();
      g.fillStyle = "#fff"; g.font = "600 13px " + font; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(initial(n.p.card.name), n.x, n.y);
      g.fillStyle = "#8e8e93"; g.font = "11px " + font;
      var nm = n.p.card.name.split(" ")[0];
      g.fillText(nm.length > 10 ? nm.slice(0, 9) + "…" : nm, n.x, n.y + 32);
    });
    var grd = g.createLinearGradient(cx - 24, cy - 24, cx + 24, cy + 24);
    grd.addColorStop(0, "#ff6b1a"); grd.addColorStop(1, "#ff9500");
    g.beginPath(); g.arc(cx, cy, 26, 0, 7); g.fillStyle = grd; g.fill();
    g.fillStyle = "#000"; g.font = "700 15px " + font;
    var me = loadCard();
    g.fillText(me ? initial(me.name) : "Y", cx, cy);
    g.fillStyle = "#8e8e93"; g.font = "11px " + font;
    g.fillText("You", cx, cy + 38);
    cv.addEventListener("click", function (e) {
      var r = cv.getBoundingClientRect();
      var x = e.clientX - r.left, y = e.clientY - r.top;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if ((x - n.x) * (x - n.x) + (y - n.y) * (y - n.y) < 27 * 27) { location.hash = "#/p/" + n.p.id; return; }
      }
    });
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
  function setupDictate(p) {
    var btn = document.getElementById("dictate");
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { btn.style.display = "none"; return; }
    var rec = null, active = false;
    btn.addEventListener("click", function () {
      if (active) { try { rec.stop(); } catch (e) {} return; }
      rec = new SR();
      rec.lang = "en-US"; rec.interimResults = true; rec.continuous = true;
      var ta = document.getElementById("note");
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

  route();
  if (loadCard() || loadPeople().length || ownerToken()) {
    ensureOwner()
      .then(function () { return syncCard(); })
      .then(function () { return migrateOnce(); })
      .then(function () { lastSync = 0; refreshSoon(); });
  }
})();
