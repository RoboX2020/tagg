// Browser test of the notification bell, list and Settings (push transport and browser push service are STUBBED). Chrome at phone size with touch; real iPhone Safari NOT covered. Test data only.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8799); const API_URL = "http://localhost:8799"; api.env.SIGNUP_PER_HOUR = "200";
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream"; r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f)); }).listen(8800);
const base = "http://localhost:8800/";
function png(w, h) { const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200 + (x * 55) / w; raw[o + 1] = 110 + (y * 60) / h; raw[o + 2] = 70; } }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let n = 0; const ok = (m) => console.log("ok -", m, ++n && "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, body, tok) { const r = await fetch(API_URL + p, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }
const shots = process.env.SHOTS || "";
try {
  const wc = globalThis.crypto.subtle;
  api.env.VAPID_JWK = JSON.stringify(await wc.exportKey("jwk", (await wc.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])).privateKey));
  const pushed = []; api.env.PUSH_SINK = async (sub, pay) => { pushed.push({ sub, pay }); return "ok"; };
  const a = await call("POST", "/api/auth/signup", { email: "na@tagg-test.invalid", password: "pw-secret-123", name: "Pat Owner" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Pat Owner", headline: "Maker", detail: "Builds", links: {} } }, a.ownerToken);
  const b = await call("POST", "/api/auth/signup", { email: "nb@tagg-test.invalid", password: "pw-secret-123", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML student", detail: "Studies ML", links: {} } }, b.ownerToken);
  const mk = async (tok, stub) => { const x = await browser.createBrowserContext(); const P = await x.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); P.on("pageerror", e => console.log("PAGEERROR", e.message));
    await P.evaluateOnNewDocument((api, tok, stub) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "na@tagg-test.invalid", name: "Pat Owner", kind: "email", emailVerified: false })); localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Pat Owner", headline: "Maker", detail: "Builds", links: {} })); localStorage.setItem("tagg.slug.v1", "mine");
      if (stub) { var mkSub = function () { return { endpoint: "https://fcm.googleapis.com/fcm/send/ui-test", toJSON: function () { return { endpoint: this.endpoint, keys: { p256dh: "x", auth: "y" } }; }, unsubscribe: function () { subbed = null; localStorage.removeItem("__sub"); return Promise.resolve(true); } }; }; var subbed = localStorage.getItem("__sub") ? mkSub() : null; window.__perm = 0; Notification = { permission: "default", requestPermission: function () { window.__perm++; Notification.permission = "granted"; return Promise.resolve("granted"); } };
        var ps = { getSubscription: function () { return Promise.resolve(subbed); }, subscribe: function (o) { window.__key = o.applicationServerKey.length; subbed = mkSub(); localStorage.setItem("__sub", "1"); subbed.toJSON = function () { return { endpoint: this.endpoint, keys: { p256dh: "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE".slice(0, 87), auth: "AAAAAAAAAAAAAAAAAAAAAA" } }; }; return Promise.resolve(subbed); } };
        Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve({ pushManager: ps }), register: function () { return Promise.resolve({}); }, addEventListener: function () {} }, configurable: true }); window.PushManager = function () {}; } }, API_URL, tok, !!stub); return P; };
  const A0 = await mk(a.ownerToken, true); await A0.goto(base + "#/settings", { waitUntil: "networkidle0" }); await sleep(2500);
  const t0 = await A0.evaluate(() => document.getElementById("notifpanel").innerText);
  assert.ok(/Alerts are not active yet/.test(t0) && /Nothing is sent right now/.test(t0) && /Saved choice|Verify your email/.test(t0)); ok("while the service is off, Settings says alerts are not active and nothing is sent");
  if (shots) { await A0.evaluate(() => window.scrollTo(0, document.getElementById("notifpanel").getBoundingClientRect().top + scrollY - 140)); await sleep(300); await A0.screenshot({ path: shots + "/notify-inactive.png" }); }
  await api.env.KV.put("cfg/notify", "on");
  const A = await mk(a.ownerToken, true);
  await A.goto(base + "#/settings", { waitUntil: "networkidle0" }); await sleep(2500);
  let t = await A.evaluate(() => document.getElementById("notifpanel").innerText);
  assert.ok(!/not active/.test(t) && /Email alerts/.test(t) && /Enable push/.test(t) && /never include notes/.test(t)); ok("Settings shows email alerts and an Enable push button with the permission note");
  assert.equal(await A.evaluate(() => window.__perm), 0); ok("the browser permission prompt was NOT triggered by opening Settings");
  assert.equal(pushed.length, 0);
  if (shots) { await A.evaluate(() => window.scrollTo(0, document.getElementById("notifpanel").getBoundingClientRect().top + scrollY - 140)); await sleep(300); await A.screenshot({ path: shots + "/notify-settings-before.png" }); }
  await A.click("#pushon"); await sleep(1500);
  t = await A.evaluate(() => document.getElementById("notifpanel").innerText);
  assert.ok(/Push on this device/.test(t) && /Turn off/.test(t) && await A.evaluate(() => window.__perm) === 1 && await A.evaluate(() => window.__key) === 65); ok("tapping Enable asks permission once, subscribes with the server key, and shows it is on");
  assert.equal((await call("GET", "/api/notify/prefs", null, a.ownerToken)).push, 1); ok("the server stored exactly one device");
  if (shots) { await A.evaluate(() => window.scrollTo(0, document.getElementById("notifpanel").getBoundingClientRect().top + scrollY - 140)); await sleep(2500); await A.screenshot({ path: shots + "/notify-settings.png" }); }
  await call("POST", "/api/connect", { slug: card.slug, requesterToken: b.ownerToken, name: "Bob Li" });
  await sleep(300);
  assert.equal(pushed.length, 1); assert.equal(pushed[0].pay.body, "Bob Li wants to connect."); ok("a request produces one push to Pat's device with the short text");
  await A.goto(base + "?r=1#/", { waitUntil: "networkidle0" }); await sleep(2500);
  const badge = await A.evaluate(() => { var b = document.querySelector(".bellbadge"); return b ? b.innerText : null; });
  assert.equal(badge, "1"); ok("the bell shows 1 unread");
  if (shots) await A.screenshot({ path: shots + "/notify-bell.png" });
  await A.click("a.bell"); await sleep(1500);
  t = await A.evaluate(() => document.getElementById("nlist").innerText);
  assert.ok(/Connection request/.test(t) && /Bob Li wants to connect/.test(t)); ok("the list shows the request");
  if (shots) await A.screenshot({ path: shots + "/notify-list.png" });
  await sleep(800);
  assert.equal((await call("GET", "/api/notify", null, a.ownerToken)).unread, 0); ok("opening the list marks everything read");
  await A.evaluate(() => { location.hash = "#/settings"; }); await sleep(2500);
  await A.click("#emailtog"); await sleep(1000);
  assert.equal((await call("GET", "/api/notify/prefs", null, a.ownerToken)).email, false); ok("the email toggle saves");
  await A.click("#pushoff"); await sleep(1200);
  assert.equal((await call("GET", "/api/notify/prefs", null, a.ownerToken)).push, 0); ok("Turn off removes the device");
  const E = await mk(b.ownerToken, false); await E.goto(base + "#/notifications", { waitUntil: "networkidle0" }); await sleep(1500);
  t = await E.evaluate(() => document.getElementById("nlist").innerText);
  assert.ok(/Nothing yet/.test(t)); ok("an empty list says so plainly");
  console.log("\nNotify UI checks passed:", n);
} catch (e) { console.error("FAIL", e.stack.split("\n").slice(0, 3).join(" | ")); process.exitCode = 1; }
await api.env.KV.delete("cfg/notify");
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
