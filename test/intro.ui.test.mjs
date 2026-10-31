// Browser test of the introduction screens. Chrome at phone size with touch; real iPhone Safari NOT covered. Test data only.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8801); const API_URL = "http://localhost:8801"; api.env.SIGNUP_PER_HOUR = "200";
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream"; r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f)); }).listen(8802);
const base = "http://localhost:8802/";
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
const mk = async (name) => { const o = await call("POST", "/api/owner", {}); const card = { name, headline: name + " headline", detail: "Builds things", email: name.toLowerCase().replace(/ /g, "") + "@intro.invalid", links: {} }; const c = await call("POST", "/api/card", { ownerToken: o.ownerToken, card }, o.ownerToken); return { t: o.ownerToken, slug: c.slug, card }; };
const save = (a, b) => call("POST", "/api/people", { slug: b.slug, event: "demo" }, a.t);
const open = async (u, hash) => { const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok, card, slug) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.card.v1", JSON.stringify(card)); localStorage.setItem("tagg.slug.v1", slug); }, API_URL, u.t, u.card, u.slug);
  await P.goto(base + hash, { waitUntil: "networkidle0" }); await sleep(1100); return P; };
const text = (P) => P.evaluate(() => document.body.innerText);
const shot = async (P, n) => { if (shots) { await P.screenshot({ path: shots + "/" + n + ".png", fullPage: true }); } };
try {
  const A = await mk("Ava Lee"), M = await mk("Max Ortiz"), T = await mk("Tess Kim");
  await save(A, M); await save(M, A); await save(M, T); await save(T, M); for (const w of [A, M, T]) await call("PUT", "/api/graph/sharing", { on: true }, w.t);
  // flag off: the screen says so and nothing is offered
  let P = await open(A, "#/intros"); assert.ok((await text(P)).includes("not available yet")); ok("with the switch off the screen offers nothing"); await P.close();
  await api.env.KV.put("cfg/intro", "on");
  // target: opts in (default is off) with the headline hidden
  P = await open(T, "#/intros"); let t = await text(P); assert.ok(t.includes("Let friends of friends ask to meet you") && t.includes("Photos are not shown")); await shot(P, "intro-target-optin");
  await P.$eval("#ic-on", e => e.click()); await sleep(1000); t = await text(P); assert.ok(t.includes("Also show my headline")); assert.equal((await call("GET", "/api/intro/consent", null, T.t)).on, true); ok("the target opts in from the screen; headline stays hidden by default"); await P.close();
  // requester: sees the target (name only), writes a note and asks
  P = await open(A, "#/intros"); t = await text(P); assert.ok(t.includes("Tess Kim") && t.includes("Through Max Ortiz") && !t.includes("Tess Kim headline")); await shot(P, "intro-requester");
  await P.$eval("#note-0", e => { e.value = "Would love to hear how you started"; e.dispatchEvent(new Event("input")); }); await P.$eval("button[data-act=ask]", e => e.click()); await sleep(1200); t = await text(P); assert.ok(t.includes("Requested")); await shot(P, "intro-requester-requested"); ok("the requester sees the target without the headline and asks through the mutual connection"); await P.close();
  // mutual: sees the request, passes it on
  P = await open(M, "#/intros"); t = await text(P); assert.ok(t.includes("Ava Lee would like to meet Tess Kim") && t.includes("Would love to hear how you started") && t.includes("Nothing else is shared")); await shot(P, "intro-mutual");
  await P.$eval("button[data-act=req-forward]", e => e.click()); await sleep(1200); t = await text(P); assert.ok(!t.includes("would like to meet")); ok("the mutual connection sees the request and passes it on"); await P.close();
  // target: sees the offer, accepts
  P = await open(T, "#/intros"); t = await text(P); assert.ok(t.includes("Ava Lee") && t.includes("Introduced by Max Ortiz") && t.includes("saved in each other")); assert.ok(!/intro\.invalid|ownerToken/.test(t)); await shot(P, "intro-target-offer");
  await P.$eval("button[data-act=offer-accept]", e => e.click()); await sleep(1200);
  const pa = (await call("GET", "/api/people", null, A.t)).people.filter(p => p.card.name === "Tess Kim"), pt = (await call("GET", "/api/people", null, T.t)).people.filter(p => p.card.name === "Ava Lee");
  assert.equal(pa.length, 1); assert.equal(pt.length, 1); assert.ok(/Introduced by Max Ortiz/.test(pa[0].event)); ok("the target accepts and both are saved, marked as introduced"); await shot(P, "intro-target-done"); await P.close();
  // settings link and the opt-out
  P = await open(M, "#/settings"); t = await text(P); assert.ok(t.includes("Introductions")); ok("Settings links to Introductions when the switch is on"); await P.close();
  console.log("\nIntro UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
