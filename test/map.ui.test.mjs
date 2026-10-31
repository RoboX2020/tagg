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
const mk = async (email, name) => { const s = await call("POST", "/api/auth/signup", { email, password: "pw-secret-123", name }); const c = await call("POST", "/api/card", { ownerToken: s.ownerToken, card: { name, headline: "Engineer", detail: "Builds things", links: {} } }, s.ownerToken); await call("PUT", "/api/graph/sharing", { on: true }, s.ownerToken); return { tok: s.ownerToken, slug: c.slug, name, email }; };
try {
  const V = await mk("mv@tagg-test.invalid", "Vera Viewer"), M = await mk("mm@tagg-test.invalid", "Milo Middle"), T = await mk("mt@tagg-test.invalid", "Tess Third"), X = await mk("mx@tagg-test.invalid", "Xena Private");
  await call("PUT", "/api/graph/sharing", { on: false }, X.tok);
  await call("POST", "/api/people", { slug: M.slug, event: "Expo" }, V.tok);
  await call("POST", "/api/people", { slug: V.slug, event: "Expo" }, M.tok);
  await call("POST", "/api/people", { slug: T.slug }, M.tok);
  await call("POST", "/api/people", { slug: X.slug }, M.tok);
  const g = await call("GET", "/api/graph", null, V.tok);
  assert.ok(g.nodes.some(n => n.name === "Tess Third") && !g.nodes.some(n => n.name === "Xena Private")); ok("server graph has the consenting friend of a friend and not the one who opted out");
  const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok, email) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email, name: "Vera Viewer", kind: "email", emailVerified: false }));
    localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Vera Viewer", headline: "Engineer", detail: "Builds things", links: {} })); localStorage.setItem("tagg.slug.v1", "vera"); localStorage.setItem("tagg.graph.skip", "1"); }, API_URL, V.tok, V.email);
  await P.goto(base + "#/map", { waitUntil: "networkidle0" }); await sleep(2500);
  const c = await P.evaluate(() => document.getElementById("graph").tagg.count());
  assert.ok(c.fof.length === 1 && c.fof[0] === "Tess" && c.dashed === 1 && c.nodes === 3); ok("map draws the friend of a friend as a hollow node linked by a dashed line, and not the opted-out person: " + JSON.stringify(c));
  const t = await P.evaluate(() => document.body.innerText);
  assert.ok(/plus 1 person they know/.test(t) && !/Xena/.test(t)); ok("map caption explains the hollow nodes");
  if (shots) await P.screenshot({ path: shots + "/map-fof.png" });
  const before = await P.evaluate(() => location.hash);
  const pt = await P.evaluate(() => { const cv = document.getElementById("graph"); const r = cv.getBoundingClientRect(); const s = cv.tagg.screen(2); return { x: r.left + s.x, y: r.top + s.y }; });
  await P.mouse.click(pt.x, pt.y); await sleep(500);
  assert.equal(await P.evaluate(() => location.hash), before); ok("tapping a friend of a friend does not open anything");
  console.log("\nMap UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
