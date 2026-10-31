// Browser test of the richer person profile page. Chrome at phone size with touch; real iPhone Safari NOT covered. Test data only.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8797); const API_URL = "http://localhost:8797"; api.env.SIGNUP_PER_HOUR = "200";
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream"; r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f)); }).listen(8798);
const base = "http://localhost:8798/";
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
  const a = await call("POST", "/api/auth/signup", { email: "ga@tagg-test.invalid", password: "alice-secret-1", name: "Alex Sample" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Alex Sample", headline: "Robotics student", detail: "Builds robot arms", email: "alex-secret@tagg-test.invalid", phone: "+1 555 0142 777", links: { github: "https://github.com/alex-sample" } } }, a.ownerToken);
  const b = await call("POST", "/api/auth/signup", { email: "gb@tagg-test.invalid", password: "bob-secret-12", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML", links: {} } }, b.ownerToken);
  await call("POST", "/api/people", { slug: card.slug, event: "Gate Expo", note: "BOB-PRIVATE-NOTE", location: { lat: 33.4, lon: -111.9, label: "Tempe, Arizona", acc: 10, at: "2026-10-30T18:00:00.000Z" } }, b.ownerToken);
  const saved = (await call("GET", "/api/people", null, b.ownerToken)).people[0];
  const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "gb@tagg-test.invalid", name: "Bob Li", kind: "email", emailVerified: false }));
    localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Bob Li", headline: "ML", links: {} })); localStorage.setItem("tagg.slug.v1", "bobli"); }, API_URL, b.ownerToken);
  await P.goto(base + "#/people", { waitUntil: "networkidle0" }); await sleep(900);
  let t = await P.evaluate(() => document.body.innerText);
  assert.ok(/Complete your profile/.test(t) && t.includes("Alex Sample")); ok("people list shows the complete-your-profile banner and still shows who they met");
  if (shots) await P.screenshot({ path: shots + "/gate-list.png" });
  await P.goto(base + "#/p/" + saved.id, { waitUntil: "networkidle0" }); await sleep(1200);
  t = await P.evaluate(() => document.body.innerText);
  assert.ok(t.includes("Complete your profile to see Alex's details") && t.includes("Robotics student") && t.includes("Gate Expo") && (await P.evaluate(() => [...document.querySelectorAll("textarea")].some(x => x.value.includes("BOB-PRIVATE-NOTE"))))); ok("locked person page keeps name, headline, event and the viewer's own note");
  assert.ok(/Add more to your profile to unlock/.test(t) && !/headline|one line|\d+ ?%|of 7/i.test((await P.evaluate(() => (document.querySelector(".lockedsec") || {}).innerText || "")))); ok("locked copy is generic: no score, percentage or list of required sections");
  const html = await P.evaluate(() => document.documentElement.outerHTML);
  assert.ok(!/alex-secret|555 0142|alex-sample|robot arms/.test(html) && !(await P.evaluate(() => localStorage.getItem("tagg.people.v1") || "")).match(/alex-secret|555 0142|alex-sample/)); ok("hidden details are not in the page or in local storage");
  assert.ok(await P.$(".lockbars") && !(await P.$("#vcf"))); ok("placeholder bars and no Save to Contacts while locked");
  if (shots) await P.screenshot({ path: shots + "/gate-person.png" });
  await P.goto(base + "#/edit", { waitUntil: "networkidle0" }); await sleep(500);
  t = await P.evaluate(() => document.body.innerText); assert.ok(/optional/.test(t) && !/must add a phone/i.test(t)); ok("edit page says phone, photo and social accounts are optional");
  await P.$eval("#f-head", e => { e.value = "ML student"; e.dispatchEvent(new Event("input")); });
  await P.$eval("#f-detail", e => { e.value = "Studies machine learning"; e.dispatchEvent(new Event("input")); });
  await P.click("#save"); await sleep(1500);
  await P.goto(base + "#/p/" + saved.id, { waitUntil: "networkidle0" }); await sleep(1500);
  t = await P.evaluate(() => document.body.innerText);
  assert.ok(!t.includes("Complete your profile to see") && (await P.$("a[href*=\"alex-secret@tagg-test.invalid\"]")) && t.includes("Builds robot arms")); ok("saving name, headline and detail unlocks the details at once");
  if (shots) await P.screenshot({ path: shots + "/gate-unlocked.png" });
  const ctxS = await browser.createBrowserContext(); const S = await ctxS.newPage(); await S.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await S.evaluateOnNewDocument((api, tok) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "gb@tagg-test.invalid", name: "Bob Li", kind: "email", emailVerified: false })); localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Bob Li", headline: "ML student", detail: "Studies machine learning", links: {} })); localStorage.setItem("tagg.slug.v1", "bobli"); }, API_URL, b.ownerToken);
  await S.goto(base + "#/c/" + card.slug, { waitUntil: "networkidle0" }); await sleep(1500);
  const st2 = await S.evaluate(() => document.body.innerText);
  assert.ok(!st2.includes("Complete your profile to see Alex") && /github/i.test(st2) && /alex-sample/.test(st2)); ok("a completed non-owner scanner sees the full card");
  if (shots) await S.screenshot({ path: shots + "/qr-complete-scanner.png" });
  const ctx2 = await browser.createBrowserContext(); const G = await ctx2.newPage(); await G.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await G.evaluateOnNewDocument((api) => { localStorage.setItem("tagg.api", api); }, API_URL);
  await G.goto(base + "#/c/" + card.slug, { waitUntil: "networkidle0" }); await sleep(1500);
  const gt = await G.evaluate(() => document.body.innerText), gh = await G.evaluate(() => document.documentElement.outerHTML);
  assert.ok(gt.includes("Alex Sample") && gt.includes("Robotics student") && gt.includes("Complete your profile to see Alex's links and contact")); ok("anonymous scan shows the minimal preview and the complete-your-profile notice");
  assert.ok(!/alex-secret|555 0142|alex-sample|robot arms/.test(gh)); ok("an anonymous scan page holds none of the hidden details");
  assert.ok(gt.includes("this name is what they typed") && !/name and email on this card/.test(gt)); ok("preview copy does not mention an email it is not showing");
  if (shots) await G.screenshot({ path: shots + "/qr-preview.png" });
  console.log("\nGate UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
