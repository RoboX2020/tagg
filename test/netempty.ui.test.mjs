// Browser test of the network empty states. Chrome at phone size with touch; real iPhone Safari NOT covered. Test data only.
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
  const mk = async (tok, stub) => { const x = await browser.createBrowserContext(); const P = await x.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); P.on("pageerror", e => console.log("PAGEERROR", e.message));
    await P.evaluateOnNewDocument((api, tok, stub) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "na@tagg-test.invalid", name: "Pat Owner", kind: "email", emailVerified: false })); localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Pat Owner", headline: "Maker", detail: "Builds", links: {} })); localStorage.setItem("tagg.slug.v1", "mine");
      if (stub) { var mkSub = function () { return { endpoint: "https://fcm.googleapis.com/fcm/send/ui-test", toJSON: function () { return { endpoint: this.endpoint, keys: { p256dh: "x", auth: "y" } }; }, unsubscribe: function () { subbed = null; localStorage.removeItem("__sub"); return Promise.resolve(true); } }; }; var subbed = localStorage.getItem("__sub") ? mkSub() : null; window.__perm = 0; Notification = { permission: "default", requestPermission: function () { window.__perm++; Notification.permission = "granted"; return Promise.resolve("granted"); } };
        var ps = { getSubscription: function () { return Promise.resolve(subbed); }, subscribe: function (o) { window.__key = o.applicationServerKey.length; subbed = mkSub(); localStorage.setItem("__sub", "1"); subbed.toJSON = function () { return { endpoint: this.endpoint, keys: { p256dh: "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE".slice(0, 87), auth: "AAAAAAAAAAAAAAAAAAAAAA" } }; }; return Promise.resolve(subbed); } };
        Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve({ pushManager: ps }), register: function () { return Promise.resolve({}); }, addEventListener: function () {} }, configurable: true }); window.PushManager = function () {}; } }, API_URL, tok, !!stub); return P; };
  const a = await call("POST", "/api/auth/signup", { email: "ne@tagg-test.invalid", password: "pw-secret-123", name: "Pat Owner" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Pat Owner", headline: "Maker", detail: "Builds", links: { linkedin: "https://www.linkedin.com/in/pat" } } }, a.ownerToken);
  const b = await call("POST", "/api/auth/signup", { email: "nf@tagg-test.invalid", password: "pw-secret-123", name: "Bob Li" });
  const bc = await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML student", detail: "Studies ML", links: { linkedin: "https://www.linkedin.com/in/bob" } } }, b.ownerToken);
  await call("POST", "/api/connect", { slug: bc.slug, requesterToken: a.ownerToken, name: "Pat Owner" });
  for (const q of (await call("GET", "/api/inbox", null, b.ownerToken)).requests) await call("POST", "/api/inbox/respond", { id: q.id, accept: true }, b.ownerToken);
  const P = await mk(a.ownerToken, false); await P.goto(base + "#/people", { waitUntil: "networkidle0" }); await sleep(2500);
  await P.evaluate(() => { var s = document.querySelector(".sheet-bg"); });
  let t = await P.evaluate(() => document.body.innerText);
  assert.ok(/Share your network\?/.test(t)); ok("an unchosen user with a filled profile gets the share choice sheet");
  await P.click("#gs-later"); await sleep(2000);
  t = await P.evaluate(() => (document.getElementById("netpeople") || {}).innerText || "");
  assert.ok(/not sharing your network yet/.test(t) && await P.$("#gs-open")); ok("after Decide later, the People tab says why nothing shows and offers Share my network");
  if (shots) { await P.evaluate(() => document.getElementById("netpeople").scrollIntoView()); await P.screenshot({ path: shots + "/net-empty.png" }); }
  await P.click("#gs-open"); await sleep(500); await P.click("#gs-yes"); await sleep(1500);
  t = await P.evaluate(() => (document.getElementById("netpeople") || {}).innerText || "");
  assert.ok(/No one to show yet/.test(t) && /you, your connection and that person all share/.test(t)); ok("once sharing is on and nobody else shares, it explains the all-share rule");
  console.log("\nNet empty UI checks passed:", n);
} catch (e) { console.error("FAIL", e.stack.split("\n").slice(0, 3).join(" | ")); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
