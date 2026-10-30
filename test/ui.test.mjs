// Browser test of the real UI against the real worker code (in-memory storage). Run: node test/ui.test.mjs
// Needs: npm i puppeteer-core, and Chrome at $CHROME (default /usr/bin/google-chrome).
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
// By default the real worker runs locally with in-memory storage. Set TAGG_API to test a deployed worker instead
// (it then creates real test accounts using unique @tagg-test.invalid emails).
const REMOTE = process.env.TAGG_API || "";
const api = REMOTE ? { srv: { close() {} } } : await start(8787);
const API_URL = REMOTE || "http://localhost:8787";
const RUN = Date.now().toString(36);
const web = http.createServer((q, r) => {
  const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]);
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream";
  r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f));
}).listen(8788);
const base = "http://localhost:8788/";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let n = 0; const ok = (m) => console.log("ok -", m, ++n && "");
async function newUser(name, geo) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(base, ["geolocation"]);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument((api) => { localStorage.setItem("tagg.api", api); }, API_URL);
  if (geo) await page.setGeolocation(geo);
  page.on("pageerror", e => console.log("PAGEERROR", name, e.message));
  return page;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = p => p.evaluate(() => document.body.innerText);
async function waitText(p, t, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if ((await text(p)).includes(t)) return; await sleep(150); } throw new Error("timeout waiting for: " + t + "\n---\n" + (await text(p))); }
async function clickText(p, sel, t) { await p.evaluate((sel, t) => { const e = [...document.querySelectorAll(sel)].find(x => x.textContent.includes(t)); if (!e) throw new Error("no " + t); e.click(); }, sel, t); }
try {
  // Alice: sign up by email from the home screen, make a card.
  const A = await newUser("alice");
  await A.goto(base, { waitUntil: "networkidle0" });
  await clickText(A, "button", "Create a new account");
  await A.type("#au-name", "Alice Ng"); await A.type("#au-email", "alice-" + RUN + "@tagg-test.invalid"); await A.type("#au-pass", "alice-secret-1");
  await clickText(A, "button", "Create account");
  await waitText(A, "Signed in as alice-" + RUN);
  await A.goto(base + "#/edit"); await sleep(500);
  await A.screenshot({ path: "/tmp/work/shot-edit.png" });
  const ids = await A.evaluate(() => [...document.querySelectorAll("input.input")].map(i => i.id));
  console.log("edit inputs:", ids.join(","));
  await A.type("#" + ids[0], "Alice Ng"); 
  await clickText(A, "button", "Save");
  await sleep(1500);
  const slug = await A.evaluate(() => localStorage.getItem("tagg.slug.v1"));
  assert.match(slug, /^[a-z0-9]{8}$/); ok("Alice has a synced card slug " + slug);

  // Bob: opens Alice's QR link, signs up as part of the scan, adds context and location.
  const B = await newUser("bob", { latitude: 33.4242, longitude: -111.9281, accuracy: 10 });
  await B.goto(base + "#/c/" + slug, { waitUntil: "networkidle0" });
  await waitText(B, "Alice Ng");
  await B.screenshot({ path: "/tmp/work/shot-scan.png", fullPage: true });
  ok("scan page shows card and account signup");
  await B.type("#au-name", "Bob Li"); await B.type("#au-email", "bob-" + RUN + "@tagg-test.invalid"); await B.type("#au-pass", "bob-secret-12");
  await B.type("#f-event", "Cal Hacks"); await B.type("#f-note", "Wants to talk sim2real");
  await B.click("#f-loc");
  await clickText(B, "button", "Create account and share");
  await waitText(B, "Shared with Alice Ng", 15000);
  await B.screenshot({ path: "/tmp/work/shot-sent.png", fullPage: true });
  ok("Bob signed up during scan and the request was sent");

  // Alice sees the request (with Bob's shared location) and accepts.
  await A.goto(base + "#/people"); await A.reload({ waitUntil: "networkidle0" }); await A.goto(base + "#/people");
  await waitText(A, "Bob Li", 15000);
  await A.screenshot({ path: "/tmp/work/shot-inbox.png", fullPage: true });
  await A.evaluate(() => document.querySelector("[data-acc]").click());
  await waitText(A, "Save the moment", 10000);
  await clickText(A, "button", "Skip for now");
  await waitText(A, "Bob Li");
  await A.screenshot({ path: "/tmp/work/shot-person.png", fullPage: true });
  const pt = await text(A);
  assert.ok(pt.includes("Cal Hacks")); assert.ok(pt.includes("33.4242")); ok("Alice's person page shows event, coordinates");
  assert.ok(await A.evaluate(() => !![...document.querySelectorAll("a")].find(a => a.href.includes("map_action=pano")))); ok("Street View link present");
  assert.ok(!pt.includes("sim2real")); ok("Bob's private context note is not on Alice's side");

  // Bob's side: reciprocal save with his private note.
  await B.goto(base + "#/people"); await B.reload({ waitUntil: "networkidle0" }); await sleep(2500);
  await B.goto(base + "#/people"); await waitText(B, "Alice Ng", 15000);
  await B.evaluate(() => document.querySelector("a[href^='#/p/']").click());
  await waitText(B, "Alice Ng"); await sleep(500);
  assert.ok((await B.$eval("#note", e => e.value)).includes("sim2real"));
  ok("Bob's saved Alice with his private note");
  console.log("\nUI checks passed:", n);
} catch (e) { console.log("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close();
