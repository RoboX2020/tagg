// Onboarding speed measurement: drives the real app in headless Chrome through the fresh-user paths and
// reports per-step wall time, taps, keystrokes and screens. Local harness: timings exclude real network
// latency, so each run repeats with a 300ms RTT throttle to approximate a phone on mobile data. Test data only.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8799); const API_URL = "http://localhost:8799"; api.env.SIGNUP_PER_HOUR = "500";
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream"; r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f)); }).listen(8800);
const base = "http://localhost:8800/";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(label, throttleMs, steps) {
  const ctx = await browser.createBrowserContext();
  const P = await ctx.newPage();
  await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  if (throttleMs) { const cdp = await P.createCDPSession(); await cdp.send("Network.enable"); await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: throttleMs, downloadThroughput: 4e6, uploadThroughput: 3e6 }); }
  await P.evaluateOnNewDocument((api) => { localStorage.setItem("tagg.api", api); }, API_URL);
  let taps = 0, keys = 0; const t0 = Date.now(); const marks = [];
  const mark = (name) => marks.push({ step: name, ms: Date.now() - t0 });
  const tap = async (sel) => { taps++; await P.click(sel); };
  const type = async (sel, text) => { await P.click(sel); keys += text.length; await P.type(sel, text, { delay: 12 }); };
  await steps({ P, mark, tap, type });
  mark("done");
  await ctx.close();
  return { label, throttleMs, taps, keys, totalMs: Date.now() - t0, marks };
}

// Path A: minimal viable - a working QR card (name + headline + detail), no account signup.
async function pathMinimal({ P, mark, tap, type }) {
  await P.goto(base, { waitUntil: "networkidle0" }); mark("landing loaded");
  await tap('a[href="#/edit"]'); await P.waitForSelector("#f-name"); mark("card editor open");
  await type("#f-name", "Pat Owner"); await type("#f-head", "Robotics engineering at ASU"); await type("#f-detail", "Robotics at ASU, lab assistant"); mark("3 required fields typed");
  await tap("#save"); await sleep(600); mark("saved, home with QR");
}
// Path B: full card - every field filled.
async function pathFull({ P, mark, tap, type }) {
  await P.goto(base, { waitUntil: "networkidle0" }); mark("landing loaded");
  await tap('a[href="#/edit"]'); await P.waitForSelector("#f-name"); mark("card editor open");
  await type("#f-name", "Pat Owner"); await type("#f-head", "Robotics engineering at ASU"); await type("#f-detail", "Robotics at ASU, lab assistant");
  await type("#f-linkedin", "patowner"); await type("#f-github", "patowner"); await type("#f-x", "patowner"); await type("#f-instagram", "patowner"); await type("#f-website", "patowner.example.com");
  await type("#f-email", "pat@tagg-test.invalid"); await type("#f-phone", "+14805550100"); mark("all 10 fields typed");
  await tap("#save"); await sleep(600); mark("saved, home with QR");
}
// Path C: email account signup from the landing auth block (login mode -> switch to signup -> 3 fields -> recovery code sheet).
async function pathSignup({ P, mark, tap, type }) {
  await P.goto(base, { waitUntil: "networkidle0" }); mark("landing loaded");
  await P.waitForSelector("#au-switch"); await tap("#au-switch"); await P.waitForSelector("#au-name"); mark("switched to Create account");
  await type("#au-name", "Pat Owner"); await type("#au-email", "pat-c-" + Math.random().toString(36).slice(2, 10) + "@tagg-test.invalid"); await type("#au-pass", "pw-secret-123"); mark("name + email + password typed");
  await tap("#au-go");
  await P.waitForSelector("#rc-ok", { timeout: 12000 }); mark("account created, recovery code shown");
  await tap("#rc-ok"); await sleep(800); mark("recovery acknowledged, signed in");
}
const results = [];
for (const th of [0, 300]) {
  results.push(await run("minimal QR card", th, pathMinimal));
  results.push(await run("full card (all 10 fields)", th, pathFull));
  results.push(await run("email signup", th, pathSignup));
}
for (const r of results) {
  console.log(`\n== ${r.label} (RTT ${r.throttleMs}ms) ==  taps=${r.taps} keystrokes=${r.keys} total=${(r.totalMs / 1000).toFixed(1)}s`);
  let prev = 0; for (const m of r.marks) { console.log(`   +${((m.ms - prev) / 1000).toFixed(1)}s  ${m.step}`); prev = m.ms; }
}
await browser.close(); api.srv.close(); web.close(); process.exit(0);
