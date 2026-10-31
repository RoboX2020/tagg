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
  await api.env.KV.put("enrich/" + card.slug, JSON.stringify({ linkedin: { headline: "Maker", titles: ["Engineer"], companies: ["Acme"], schools: ["ASU"], about: "I build robots. ".repeat(20), experience: [{ title: "Engineer", company: "Acme", period: "2024 - Present", place: "Tempe", text: "Built things." }, { title: "Intern", company: "Beta", period: "2023", place: "", text: "" }], education: [{ school: "ASU", degree: "BS, Robotics", period: "2022 - 2026" }], skills: ["Python", "Robotics"], importedAt: new Date().toISOString() } }));
  const B = await mkPage(b.ownerToken, "cb@tagg-test.invalid", "Bob Li", 390, 844);
  await B.goto(base + "#/c/" + card.slug, { waitUntil: "networkidle0" }); await sleep(1500);
  const st = await B.evaluate(() => { const r = document.querySelector("[data-rm]"), b = document.querySelector("[data-rmbtn]"); return r && b ? { h: r.getBoundingClientRect().height, btn: b.textContent, vis: b.getBoundingClientRect().height > 0, txt: r.innerText } : null; });
  assert.ok(st && st.h <= 151 && st.btn === "Read more" && st.vis); ok("mobile starts collapsed with Read more: " + st.h);
  assert.ok(/Experience/.test(st.txt) && /Skills/.test(st.txt) && /Present/.test(st.txt)); ok("rich LinkedIn sections are in the page text");
  if (shots) await B.screenshot({ path: shots + "/readmore-closed.png" });
  await B.click("[data-rmbtn]"); await sleep(300);
  const op = await B.evaluate(() => ({ h: document.querySelector("[data-rm]").getBoundingClientRect().height, t: document.querySelector("[data-rmbtn]").textContent }));
  assert.ok(op.h > 200 && op.t === "Show less"); ok("Read more expands in place: " + op.h);
  await B.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await sleep(400);
  const bt = await B.evaluate(() => { const nav = document.querySelector("nav, .tabbar, .bottomnav"); const kids = [...document.querySelector(".content").children].filter(e => e.getBoundingClientRect().height > 0); const last = kids[kids.length - 1].getBoundingClientRect(); const nb = nav ? nav.getBoundingClientRect().top : innerHeight; return { lastBottom: last.bottom, navTop: nb, hasNav: !!nav }; });
  assert.ok(bt.lastBottom <= bt.navTop + 1); ok("scrolled to the bottom, the last content block clears the nav: " + JSON.stringify(bt));
  if (shots) await B.screenshot({ path: shots + "/readmore-bottom.png" });
  await B.evaluate(() => window.scrollTo(0, 0)); await sleep(200);
  if (shots) await B.screenshot({ path: shots + "/readmore-open.png" });
  const D = await mkPage(b.ownerToken, "cb@tagg-test.invalid", "Bob Li", 1280, 800);
  await D.goto(base + "#/c/" + card.slug, { waitUntil: "networkidle0" }); await sleep(1500);
  const dk = await D.evaluate(() => ({ h: document.querySelector("[data-rm]").getBoundingClientRect().height, bh: document.querySelector("[data-rmbtn]").getBoundingClientRect().height }));
  assert.ok(dk.h > 200 && dk.bh === 0); ok("desktop shows everything, no button: " + JSON.stringify(dk));
  console.log("\nRich UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
