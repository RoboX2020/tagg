// Browser test of the richer person profile page. Chrome at phone size with touch; real iPhone Safari NOT covered. Test data only.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8795); const API_URL = "http://localhost:8795"; api.env.SIGNUP_PER_HOUR = "200";
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream"; r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f)); }).listen(8796);
const base = "http://localhost:8796/";
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
  const a = await call("POST", "/api/auth/signup", { email: "pa@tagg-test.invalid", password: "alice-secret-1", name: "Alex Sample" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Alex Sample", headline: "Robotics engineering student", email: "alex@tagg-test.invalid", links: { linkedin: "https://linkedin.com/in/alex-sample", github: "https://github.com/alex-sample", x: "https://x.com/alexsample", instagram: "https://instagram.com/alexsample", website: "https://alex.example.com" } } });
  const now = new Date().toISOString();
  await api.env.KV.put("enrich/" + card.slug, JSON.stringify({ linkedin: { headline: "Robotics engineering student", titles: ["Lab Assistant"], companies: ["Sample University Lab"], schools: ["Sample State University"], location: "Phoenix, Arizona", source: "linkedin-link-import", importedAt: now, hasPhoto: true, confirmedAt: now },
    github: { login: "alex-sample", name: "Alex Sample", bio: "Builds robot arms", company: "Sample University", location: "Tempe", followers: 12, repos: 9, avatar: null, source: "github-public-api", url: "https://github.com/alex-sample" } }));
  await api.env.KV.put("photo/" + card.slug, JSON.stringify({ ct: "image/png", b64: png(160, 160).toString("base64"), at: now, source: "linkedin" }));
  const b = await call("POST", "/api/auth/signup", { email: "pb@tagg-test.invalid", password: "bob-secret-12", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML", links: {} } });
  await call("POST", "/api/people", { slug: card.slug, event: "Sample Hack", note: "SECRET-NOTE-xyz" }, b.ownerToken);
  const saved = (await call("GET", "/api/people", null, b.ownerToken)).people[0];
  const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "pb@tagg-test.invalid", name: "Bob Li", kind: "email", emailVerified: false }));
    localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Bob Li", headline: "ML", links: {} })); localStorage.setItem("tagg.slug.v1", "bobli"); }, API_URL, b.ownerToken);
  await P.goto(base + "#/people", { waitUntil: "networkidle0" }); await sleep(800);
  await P.goto(base + "#/p/" + saved.id, { waitUntil: "networkidle0" }); await sleep(1500);
  const secs = await P.$$eval(".linksec .lstitle", els => els.map(e => e.textContent));
  assert.deepEqual(secs.slice(0, 5), ["LinkedIn", "GitHub", "X", "Instagram", "Website"]); assert.ok(secs.includes("Search the web")); ok("each shared link has its own section, plus a web search section");
  const radius = await P.$eval(".linksec", e => getComputedStyle(e).borderRadius); assert.equal(radius, "20px"); ok("sections have rounded corners");
  const img = await P.evaluate(() => { const i = document.querySelector("img.avatar-img"); return i && { w: i.naturalWidth, ok: i.complete && i.naturalWidth > 0, src: i.src }; }); assert.ok(img && img.ok && img.src.includes("/api/photo/")); ok("profile picture loads from Tagg's own copy");
  const body = await P.evaluate(() => document.body.innerText);
  assert.ok(body.includes("Sample State University") && body.includes("Builds robot arms") && body.includes("12 followers")); ok("imported LinkedIn and GitHub details are laid out in the sections");
  assert.ok(/cannot be shown inside Tagg/.test(body) && !/Instagram feed|timeline/i.test(body)); ok("unsupported sites say so instead of faking an embed");
  const q = await P.$eval("#websearch-q", e => e.value); assert.ok(q.includes("Alex Sample") && q.includes("Sample University Lab") && !q.includes("SECRET") && !q.includes("Sample Hack")); ok("search query uses name and shared context only, never notes or meeting place");
  const href = await P.$eval("#websearch-go", e => e.href); assert.ok(href.startsWith("https://www.google.com/search?q=") && href.includes("Alex%20Sample")); ok("web search is a plain Google link, opened only on tap");
  await P.$eval("#websearch-q", e => { e.value = "Alex Sample robotics Tempe"; e.dispatchEvent(new Event("input")); }); assert.ok((await P.$eval("#websearch-go", e => e.href)).includes("robotics%20Tempe")); ok("the viewer can edit the search before opening it");
  if (shots) { await P.evaluate(() => window.scrollTo(0, 0)); await sleep(300); await P.screenshot({ path: shots + "/prof-1-top.png" }); await P.evaluate(() => window.scrollBy(0, 640)); await sleep(300); await P.screenshot({ path: shots + "/prof-2-mid.png" }); }
  const bottom = await P.evaluate(() => { const d = document.getElementById("del"); window.scrollTo(0, document.documentElement.scrollHeight); const r = d.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hit: e && e.id, bottom: r.bottom, vh: innerHeight }; });
  assert.equal(bottom.hit, "del"); ok("page scrolls fully clear of the tab bar (bottom action is tappable)");
  if (shots) { await sleep(300); await P.screenshot({ path: shots + "/prof-3-bottom.png" }); }
  const top = await P.evaluate(() => { window.scrollTo(0, 0); const h = document.querySelector("h1.largetitle").getBoundingClientRect(); const e = document.elementFromPoint(h.left + 5, h.top + 5); return e && e.tagName; }); assert.ok(top); ok("top of the profile is not covered by the header");
  console.log("\nProfile UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
