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
const realFetch = globalThis.fetch;
let upstream = 0;
globalThis.fetch = async (u, i) => String(u).startsWith("https://nominatim.openstreetmap.org/") ? (upstream++, new Response(JSON.stringify({ name: "Memorial Union", category: "amenity", type: "university", address: { city: "Tempe", state: "Arizona" } }), { status: 200 })) : realFetch(u, i);
try {
  const a = await call("POST", "/api/auth/signup", { email: "pa@tagg-test.invalid", password: "alice-secret-1", name: "Pat Owner" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Pat Owner", headline: "Maker", detail: "Builds", links: {} } }, a.ownerToken);
  const b = await call("POST", "/api/auth/signup", { email: "pb@tagg-test.invalid", password: "bob-secret-12", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML student", detail: "Studies ML", links: {} } }, b.ownerToken);
  const ctx = await browser.createBrowserContext(); await ctx.overridePermissions("http://localhost:8800", ["geolocation"]);
  const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await P.setGeolocation({ latitude: 33.41744, longitude: -111.93469, accuracy: 15 });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "pb@tagg-test.invalid", name: "Bob Li", kind: "email", emailVerified: false }));
    localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Bob Li", headline: "ML student", detail: "Studies ML", links: {} })); localStorage.setItem("tagg.slug.v1", "bobli"); }, API_URL, b.ownerToken);
  await P.goto(base + "#/c/" + card.slug, { waitUntil: "networkidle0" }); await sleep(2500);
  const t = await P.evaluate(() => document.body.innerText);
  assert.ok(/sent to Tagg and to the free OpenStreetMap lookup/.test(t) && /Location ready/.test(t) && upstream === 0); ok("disclosure is on the page and no coordinates went to OpenStreetMap before saving");
  await P.evaluate(() => { var e = document.getElementById("locstatus"); if (e) e.scrollIntoView({ block: "center" }); }); await sleep(300); if (process.env.SHOTS) await P.screenshot({ path: process.env.SHOTS + "/place-scan.png" });
  await P.click("#saveonly"); await sleep(1800);
  const people = (await call("GET", "/api/people", null, b.ownerToken)).people;
  const L = people[0] && people[0].location;
  assert.ok(upstream === 1); ok("exactly one upstream lookup, made on save");
  assert.ok(L && L.place === "Memorial Union" && L.guess === true && L.placeSource === "OpenStreetMap" && L.acc === 15 && L.lat === 33.41744); ok("saved meeting stores the guess flag, GPS accuracy and coordinates");
  await P.goto(base + "#/p/" + people[0].id, { waitUntil: "networkidle0" }); await sleep(1200);
  const t2 = await P.evaluate(() => document.body.innerText);
  assert.ok(/Near Memorial Union/.test(t2) && /may not be exact/.test(t2) && await P.$("#place-edit")); ok("person page shows Near label with an Edit control");
  if (process.env.SHOTS) await P.screenshot({ path: process.env.SHOTS + "/place-person.png" });
  P.on("dialog", d => d.accept("Coffee with Sam"));
  await P.click("#place-edit"); await sleep(1500);
  const t3 = await P.evaluate(() => document.body.innerText);
  const L2 = (await call("GET", "/api/people", null, b.ownerToken)).people[0].location;
  assert.ok(/Coffee with Sam/.test(t3) && !/Near Coffee/.test(t3) && L2.place === "Coffee with Sam" && L2.guess === false && L2.lat === 33.41744 && L2.acc === 15); ok("editing the place replaces the guess and keeps coordinates and accuracy");
  if (process.env.SHOTS) await P.screenshot({ path: process.env.SHOTS + "/place-edited.png" });
  console.log("\nPlace UI checks passed: " + n);
} catch (e) { console.log("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
