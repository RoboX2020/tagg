// Browser test of the richer person profile page. Chrome at phone size with touch; real iPhone Safari NOT covered. Test data only.
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
  const a = await call("POST", "/api/auth/signup", { email: "ca@tagg-test.invalid", password: "pw-secret-123", name: "Pat Owner" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Pat Owner", headline: "Maker", detail: "Builds", links: {} } }, a.ownerToken);
  const b = await call("POST", "/api/auth/signup", { email: "cb@tagg-test.invalid", password: "pw-secret-123", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML student", detail: "Studies ML", links: {} } }, b.ownerToken);
  const mkPage = async (tok, email, name, w, h) => { const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: w < 600, hasTouch: w < 600 }); P.on("pageerror", e => console.log("PAGEERROR", e.message));
    await P.evaluateOnNewDocument((api, tok, email, name) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email, name, kind: "email", emailVerified: false })); localStorage.setItem("tagg.card.v1", JSON.stringify({ name, headline: "Engineer", detail: "Builds things", links: {} })); localStorage.setItem("tagg.slug.v1", "mine"); }, API_URL, tok, email, name); return P; };
  const B = await mkPage(b.ownerToken, "cb@tagg-test.invalid", "Bob Li", 390, 844);
  await B.goto(base + "#/c/" + card.slug, { waitUntil: "networkidle0" }); await sleep(1500);
  const top = await B.evaluate(() => { const e = document.getElementById("connect-top"); if (!e) return null; const r = e.getBoundingClientRect(); return { y: r.top, text: e.textContent }; });
  assert.ok(top && top.y < 600 && /Connect with Pat/.test(top.text)); ok("scanned page has Connect in the top section: " + JSON.stringify(top));
  if (shots) await B.screenshot({ path: shots + "/connect-top.png" });
  await B.click("#connect-top"); await sleep(2500);
  const inbox = await call("GET", "/api/inbox", null, a.ownerToken);
  assert.ok(inbox.requests && inbox.requests.length === 1); ok("top Connect sends exactly one request through the same flow");
  const A = await mkPage(a.ownerToken, "ca@tagg-test.invalid", "Pat Owner", 390, 844);
  await A.goto(base + "#/", { waitUntil: "networkidle0" }); await sleep(2500);
  const bar = await A.evaluate(() => { const e = document.querySelector(".reqbar"); return e ? { text: e.innerText, y: e.getBoundingClientRect().top } : null; });
  assert.ok(bar && /1 connection request/.test(bar.text) && bar.y < 140); ok("pending request bar sits at the top of the home screen: " + JSON.stringify(bar));
  if (shots) await A.screenshot({ path: shots + "/request-bar.png" });
  const D = await mkPage(a.ownerToken, "ca@tagg-test.invalid", "Pat Owner", 1280, 800);
  await D.goto(base + "#/map", { waitUntil: "networkidle0" }); await sleep(2000);
  const dg = await D.evaluate(() => { const r = document.querySelector(".reqbar").getBoundingClientRect(), c = document.querySelector(".content").getBoundingClientRect(); return { barBottom: r.bottom, contentTop: c.top }; });
  assert.ok(dg.contentTop >= dg.barBottom - 1); ok("on desktop the bar does not overlap the content: " + JSON.stringify(dg));
  if (shots) await D.screenshot({ path: shots + "/request-bar-desktop.png" });
  console.log("\nConnect UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
