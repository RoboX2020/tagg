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
  const b = await call("POST", "/api/auth/signup", { email: "gs@tagg-test.invalid", password: "bob-secret-12", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML student", detail: "Studies machine learning", links: {} } }, b.ownerToken);
  const st = await call("GET", "/api/graph/sharing", null, b.ownerToken); assert.equal(st.needsChoice, true); assert.equal(st.choice, "preselected-on"); assert.equal(st.effective, true); ok("a new account starts preselected, on by default, with the notice pending");
  const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "gs@tagg-test.invalid", name: "Bob Li", kind: "email", emailVerified: false }));
    localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Bob Li", headline: "ML student", detail: "Studies machine learning", links: {} })); localStorage.setItem("tagg.slug.v1", "bobli"); }, API_URL, b.ownerToken);
  await P.goto(base + "#/people", { waitUntil: "networkidle0" }); await sleep(1200);
  let t = await P.evaluate(() => document.body.innerText);
  assert.ok(t.includes("Share your network?") && /Never your notes, where you met/.test(t) && t.includes("Keep it private") && t.includes("Decide later")); ok("onboarding notice shows what is and is not shared, with a choice");
  if (shots) await P.screenshot({ path: shots + "/graph-notice.png" });
  await P.$eval("#gs-yes", e => e.click()); await sleep(900);
  assert.equal((await call("GET", "/api/graph/sharing", null, b.ownerToken)).choice, "on"); ok("tapping Share records the choice on the server");
  await P.goto(base + "#/settings", { waitUntil: "networkidle0" }); await sleep(1000);
  t = await P.evaluate(() => document.body.innerText); assert.ok(t.includes("Network sharing") && t.includes("Currently on.")); ok("Settings shows network sharing as on");
  if (shots) { await P.$eval("#netpanel", e => e.scrollIntoView({ block: "center" })); await sleep(300); await P.screenshot({ path: shots + "/graph-settings.png" }); }
  await P.$eval("#gs-off", e => e.click()); await sleep(900);
  assert.equal((await call("GET", "/api/graph/sharing", null, b.ownerToken)).choice, "off"); ok("Settings opt-out takes effect on the server");
  console.log("\nGraph UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
