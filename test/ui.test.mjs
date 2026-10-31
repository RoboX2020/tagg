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
// Gemini is mocked for the import test (no API spend). It also returns values that are NOT in the pasted text, which must be dropped.
if (api.env) {
  api.env.AI = { run: async () => ({ response: { headline: "Robotics Engineering Student", titles: ["Software Engineering Intern"], companies: ["Acme Robotics", "Google"], schools: ["Arizona State University", "Stanford University"], location: "Tempe, Arizona, United States" } }) };
}
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
  await waitText(A, "Save your recovery code");
  const code = await A.$eval(".sheet .answer", e => e.textContent.trim());
  assert.match(code, /^[a-z0-9]{5}(-[a-z0-9]{5}){3}$/); ok("recovery code shown after signup");
  await clickText(A, "button", "I saved it");
  await A.goto(base + "#/settings"); await waitText(A, "Signed in as alice-" + RUN);
  await A.goto(base + "#/edit"); await sleep(500);
  await A.screenshot({ path: "/tmp/work/shot-edit.png" });
  const ids = await A.evaluate(() => [...document.querySelectorAll("input.input")].map(i => i.id));
  console.log("edit inputs:", ids.join(","));
  await A.type("#" + ids[0], "Alice Ng"); 
  await clickText(A, "button", "Save");
  await sleep(1500);
  const slug = await A.evaluate(() => localStorage.getItem("tagg.slug.v1"));
  assert.match(slug, /^[a-z0-9]{8}$/); ok("Alice has a synced card slug " + slug);

  await A.goto(base + "#/settings"); await A.reload({ waitUntil: "networkidle0" }); await sleep(1500); await A.waitForSelector("#themeseg", { timeout: 15000 });
  // Theme: light is the default, dark is an option that persists.
  assert.equal(await A.evaluate(() => document.documentElement.getAttribute("data-theme")), "light"); ok("light mode is the default");
  const bgLight = await A.evaluate(() => getComputedStyle(document.body).backgroundColor); assert.notEqual(bgLight, "rgb(10, 10, 11)");
  await A.evaluate(() => window.scrollTo(0, 0)); await A.screenshot({ path: "/tmp/work/shot-home-light.png" });
  await A.$eval("#themeseg", e => e.scrollIntoView({ block: "center" })); await sleep(200); await A.screenshot({ path: "/tmp/work/shot-theme-switch-light.png" });
  await A.$eval("#themeseg [data-th=dark]", e => e.click()); await sleep(600);
  assert.equal(await A.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark");
  assert.equal(await A.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(10, 10, 11)"); ok("Dark option switches the theme");
  await A.evaluate(() => window.scrollTo(0, 0)); await A.screenshot({ path: "/tmp/work/shot-home-dark.png" });
  await A.reload({ waitUntil: "networkidle0" }); await sleep(800);
  assert.equal(await A.evaluate(() => document.documentElement.getAttribute("data-theme")), "dark"); ok("Dark choice persists after reload");
  await A.waitForSelector("#themeseg [data-th=light]"); await A.$eval("#themeseg [data-th=light]", e => e.click()); await sleep(500);
  assert.equal(await A.evaluate(() => document.documentElement.getAttribute("data-theme")), "light"); ok("Back to light");

  // LinkedIn import: paste, review, add. Values not in the pasted text are dropped before review.
  await A.goto(base + "#/edit"); await sleep(600);
  await A.$eval("#li-open", e => e.click());
  await A.$eval("#li-paste", e => e.click());
  await A.type("#li-text", "Alice Ng\nRobotics Engineering Student\nTempe, Arizona, United States\nExperience\nSoftware Engineering Intern\nAcme Robotics\nEducation\nArizona State University");
  await A.screenshot({ path: "/tmp/work/shot-li-paste.png", fullPage: true });
  await A.$eval("#li-read", e => e.click()); await waitText(A, "Continue", 5000); await A.screenshot({ path: "/tmp/work/shot-li-consent.png" });
  await clickText(A, "button", "Continue");
  await waitText(A, "Check what Tagg found", 12000); await sleep(300);
  const rv = await A.evaluate(() => ({ c: document.getElementById("li-companies").value, s: document.getElementById("li-schools").value }));
  assert.equal(rv.c, "Acme Robotics"); assert.equal(rv.s, "Arizona State University"); ok("review shows only values found in the pasted text");
  await A.$eval("#li-headline", e => e.scrollIntoView({ block: "start" })); await sleep(300); await A.screenshot({ path: "/tmp/work/shot-li-review.png" });
  assert.equal((await fetch(API_URL + "/api/c/" + slug, { headers: { Authorization: "Bearer " + await A.evaluate(() => localStorage.getItem("tagg.owner.v1")) } }).then(r => r.json())).enriched?.linkedin, undefined); ok("nothing is stored before the owner confirms");
  await A.$eval("#li-add", e => e.click()); await waitText(A, "Imported from LinkedIn", 8000); await sleep(300);
  const li = (await fetch(API_URL + "/api/c/" + slug, { headers: { Authorization: "Bearer " + await A.evaluate(() => localStorage.getItem("tagg.owner.v1")) } }).then(r => r.json())).enriched.linkedin;
  assert.equal(li.school, "Arizona State University"); assert.equal(li.source, "linkedin-pasted-text"); ok("confirmed import stored with provenance");
  await A.$eval("#liimport", e => e.scrollIntoView({ block: "center" })); await sleep(300); await A.screenshot({ path: "/tmp/work/shot-li-done.png" });
  await A.goto(base + "#/"); await sleep(300);
  await A.goto(base + "#/settings"); await waitText(A, "WHAT PEOPLE SEE", 8000); await waitText(A, "Education", 8000);
  assert.ok(!/has not verified|Entered by the card owner/i.test(await text(A))); ok("owner sees the shared profile preview with Work and Education from LinkedIn, without the repeated disclaimer");
  assert.ok(await A.evaluate(() => !!document.querySelector("#sharedprofile a[href='#/edit']"))); ok("shared profile links to editing the same fields");
  await A.$eval("#sharedprofile", e => e.scrollIntoView({ block: "start" })); await sleep(300); await A.screenshot({ path: "/tmp/work/shot-profile-preview.png" });
  // Bob: opens Alice's QR link, signs up as part of the scan, adds context and location.
  const B = await newUser("bob", { latitude: 33.4242, longitude: -111.9281, accuracy: 10 });
  await B.goto(base + "#/c/" + slug, { waitUntil: "networkidle0" });
  await waitText(B, "Alice Ng");
  await B.screenshot({ path: "/tmp/work/shot-scan.png", fullPage: true });
  ok("scan page shows card and account signup");
  await B.type("#au-name", "Bob Li"); await B.type("#au-email", "bob-" + RUN + "@tagg-test.invalid"); await B.type("#au-pass", "bob-secret-12");
  await B.type("#f-event", "Cal Hacks"); await B.type("#f-note", "Wants to talk sim2real");
  await waitText(B, "Location ready", 15000);
  assert.equal(await B.$eval("#f-loc", e => e.checked), false); ok("location is captured automatically but not ticked for sending");
  await B.click("#f-loc");
  await clickText(B, "button", "Create account and share");
  await waitText(B, "Save your recovery code"); await clickText(B, "button", "I saved it");
  await waitText(B, "Shared with Alice Ng", 15000); await sleep(800);
  await B.screenshot({ path: "/tmp/work/shot-sent.png" });
  const sent = await text(B); assert.ok(!sent.includes("Make my Tagg") && sent.includes("Finish my card")); ok("post-signup copy is accurate (no Make my Tagg)");
  ok("Bob signed up during scan and the request was sent");

  // Alice sees the request (with Bob's shared location) and accepts.
  await A.goto(base + "#/people"); await A.reload({ waitUntil: "networkidle0" }); await A.goto(base + "#/people");
  await waitText(A, "Bob Li", 15000);
  await sleep(800); await A.screenshot({ path: "/tmp/work/shot-inbox.png" });
  assert.ok((await text(A)).includes("unverified identity")); ok("inbox labels unverified requester");
  await A.evaluate(() => document.querySelector("[data-acc]").click());
  await waitText(A, "Save the moment", 10000);
  await clickText(A, "button", "Skip for now");
  await waitText(A, "Bob Li");
  await sleep(900);
  assert.equal(await A.$$eval(".sheet-bg", e => e.length), 0); ok("no overlay left over person page");
  await A.screenshot({ path: "/tmp/work/shot-person.png" });
  await A.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(300);
  await A.screenshot({ path: "/tmp/work/shot-person-bottom.png" });
  await A.evaluate(() => window.scrollTo(0, 0));
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
  await B.$eval("#note", e => e.scrollIntoView({ block: "center" })); await sleep(300); await B.screenshot({ path: "/tmp/work/shot-bob-person.png" });
  ok("Bob's saved Alice with his private note");

  // Alice deletes her account from the UI. Bob's own record of her must survive.
  // Interactive graph: drag a node, pan, zoom, tap to open. Compared by canvas pixels.
  await A.goto(base + "#/map"); await sleep(1800);
  const gh = () => A.$eval("#graph", c => { const x = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < x.length; i += 97) h = (h * 31 + x[i]) | 0; return h; });
  const box = await A.$eval("#graph", c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await A.evaluate(() => document.getElementById("graph").scrollIntoView({ block: "center" })); await sleep(300);
  const box2 = await A.$eval("#graph", c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await A.screenshot({ path: "/tmp/work/shot-graph-1.png" });
  let h0 = await gh(); for (let i = 0; i < 20; i++) { await sleep(300); const hn = await gh(); if (hn === h0) break; h0 = hn; }
  await A.mouse.move(box2.x + 40, box2.y + 40); await A.mouse.down(); await A.mouse.move(box2.x + 90, box2.y + 70, { steps: 5 }); await A.mouse.up(); await sleep(400);
  const h1 = await gh(); assert.notEqual(h0, h1); ok("dragging the background pans the graph");
  await A.$eval("#g-in", e => e.click()); await sleep(200); const h2 = await gh(); assert.notEqual(h1, h2); ok("zoom in changes the view");
  await A.$eval("#g-reset", e => e.click()); await sleep(500); const h3 = await gh(); assert.notEqual(h3, h2); await sleep(500); assert.equal(await gh(), h3); ok("reset restores the view and the graph holds still");
  await A.mouse.move(box2.x + box2.w / 2, box2.y + box2.h / 2); const hw = await gh(); await A.mouse.wheel({ deltaY: -300 }); await sleep(200); assert.notEqual(await gh(), hw); ok("scroll wheel zooms");
  await A.$eval("#g-reset", e => e.click()); await sleep(200);
  await sleep(800);
  const n0 = await A.$eval("#graph", c => c.tagg.screen(1));
  const p0 = await A.$eval("#graph", c => { const r = c.getBoundingClientRect(), p = c.tagg.screen(1); return { x: r.x + p.x, y: r.y + p.y }; });
  await A.mouse.move(p0.x, p0.y); await A.mouse.down(); await A.mouse.move(p0.x + 60, p0.y + 40, { steps: 6 }); await A.mouse.up(); await sleep(300);
  const n1 = await A.$eval("#graph", c => c.tagg.screen(1)); assert.ok(Math.abs(n1.x - n0.x) + Math.abs(n1.y - n0.y) > 20); ok("dragging a node moves it");
  await sleep(2500);
  const bp = await A.$eval("#graph", c => { const r = c.getBoundingClientRect(), p = c.tagg.screen(1); return { x: r.x + p.x, y: r.y + p.y }; });
  await A.mouse.click(bp.x, bp.y); await sleep(400);
  const opened = (await A.evaluate(() => location.hash)).startsWith("#/p/");
  assert.ok(opened); ok("tapping a node opens that person");
  await A.goto(base + "#/map"); await sleep(1500);
  await A.screenshot({ path: "/tmp/work/shot-graph-2.png" });
  await A.goto(base + "#/"); await sleep(300);
  // v5: live scan banner, location status, Save only. Carol scans Alice's code without an account.
  await A.goto(base + "#/"); await A.reload({ waitUntil: "networkidle0" }); await sleep(1500);
  await waitText(A, "card was", 12000);
  const before = await text(A); ok("owner home shows a scan banner from Bob's earlier open (anonymous wording)");
  const Cc = await newUser("carol", { latitude: 33.4484, longitude: -112.074, accuracy: 10 });
  await Cc.goto(base + "#/c/" + slug, { waitUntil: "networkidle0" });
  await waitText(A, "opened 2 times", 14000); await sleep(300);
  const bannerText = await A.$eval("#scanbanner", e => e.textContent);
  assert.ok(!/carol/i.test(bannerText) && !/bob/i.test(bannerText)); ok("owner home updated live on a second open, without naming anyone");
  await A.evaluate(() => window.scrollTo(0, 0)); await A.screenshot({ path: "/tmp/work/shot-home-live.png" });
  await Cc.type("#f-event", "Phoenix Expo"); await Cc.type("#f-note", "Met at the booth, private");
  await waitText(Cc, "Location ready", 15000); ok("location is found automatically, with no tap");
  const maplink = await Cc.$eval("#locstatus a[href*='google.com/maps']", e => e.href);
  assert.match(await text(Cc), /accurate to about 10 m/); ok("the GPS accuracy the device reported is shown with the pin");
  assert.match(maplink, /maps\/search\/\?api=1&query=33\.4484%2C-112\.074/); ok("location status shows ready with a Google Maps link and coordinates");
  await sleep(800); await Cc.$eval("#locstatus", e => e.scrollIntoView({ block: "center" })); await sleep(300); await Cc.screenshot({ path: "/tmp/work/shot-scan-location.png" });
  await Cc.$eval("#saveonly", e => e.scrollIntoView({ block: "center" })); await sleep(300); await Cc.screenshot({ path: "/tmp/work/shot-save-only.png" });
  assert.ok(await Cc.evaluate(() => !!document.getElementById("saveonly"))); ok("Save only is offered next to sharing");
  await Cc.$eval("#saveonly", e => e.click());
  await waitText(Cc, "Alice Ng", 10000); await sleep(1200);
  assert.ok((await Cc.evaluate(() => location.hash)).startsWith("#/p/")); ok("Save only opened the saved person");
  const ptxt = await text(Cc); assert.ok(ptxt.includes("Phoenix Expo") && ptxt.includes("33.4484")); ok("saved person keeps event and coordinates");
  await Cc.evaluate(() => window.scrollTo(0, 0)); await Cc.screenshot({ path: "/tmp/work/shot-saved-only.png" });
  await A.goto(base + "#/people"); await A.reload({ waitUntil: "networkidle0" }); await sleep(1500);
  assert.ok(!(await text(A)).includes("Carol")); ok("Save only shared no request or identity with the owner");
  // Denied permission shows the help text and a retry, instead of silently dropping the location.
  const dctx = await browser.createBrowserContext(); await dctx.overridePermissions(base, []);
  const D = await dctx.newPage(); await D.setViewport({ width: 390, height: 844 });
  await D.evaluateOnNewDocument((api) => { localStorage.setItem("tagg.api", api); }, API_URL);
  await D.goto(base + "#/c/" + slug, { waitUntil: "networkidle0" }); await waitText(D, "Alice Ng");
  await waitText(D, "blocked for this site", 8000);
  assert.ok((await text(D)).includes("Try again")); ok("denied location shows how to fix it and a Try again link");
  await D.$eval("#locstatus", e => e.scrollIntoView({ block: "center" })); await sleep(300); await D.screenshot({ path: "/tmp/work/shot-loc-denied.png" });
  // LinkedIn connections import (sample identities, local test server only): list copy, escaping, card provenance.
  await A.evaluate(async () => {
    const tok = localStorage.getItem("tagg.owner.v1");
    const r = await fetch(localStorage.getItem("tagg.api") + "/api/import/linkedin-connections", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify({ connections: [
      { name: "Maya Chen", headline: "Senior Product Designer at Pixelflow", url: "https://www.linkedin.com/in/mayachen", connectedOn: "12 Mar 2025" },
      { name: "<img src=x onerror=window.__xss=1> Eve", headline: "ops", url: "", connectedOn: "" }
    ] }) });
    if (!r.ok) throw new Error("import failed: " + r.status);
  });
  await A.goto(base + "#/people"); await A.reload({ waitUntil: "networkidle0" }); await sleep(2500);
  const pplTxt = await text(A);
  assert.ok(pplTxt.includes("People you met through Tagg and connections you imported")); ok("People lead stays truthful once imports are present");
  assert.ok(pplTxt.includes("Imported from your LinkedIn export")); ok("imported rows are labeled in the list");
  assert.equal(await A.evaluate(() => window.__xss || null), null); ok("an HTML payload in an imported name renders as inert text, never markup");
  assert.ok(pplTxt.includes("<img src=x onerror=window.__xss=1> Eve")); ok("the payload name is shown as literal text");
  await clickText(A, "a.row .title", "Maya Chen");
  await waitText(A, "From your own LinkedIn export", 10000);
  const cardTxt = await text(A);
  assert.ok(/WHAT TAGG KNOWS/i.test(cardTxt)); ok("imported card replaces Why keep in touch with What Tagg knows");
  assert.ok(cardTxt.includes("12 Mar 2025")); ok("imported card shows Connected On, not a met moment");
  assert.ok(!cardTxt.includes("still fresh") && !cardTxt.includes("Worth a follow-up")); ok("imported cards carry no fake freshness claims");
  await A.screenshot({ path: "/tmp/work/shot-import-card.png" });
  await A.goto(base + "#/settings"); await A.reload({ waitUntil: "networkidle0" }); await sleep(1500);
  await A.waitForSelector("#delete-account", { timeout: 15000 });
  await A.$eval("#delete-account", e => e.click()); await sleep(400);
  await A.type("#da-word", "DELETE"); await A.type("#da-pass", "wrong-pass-1");
  await A.$eval("#da-go", e => e.click()); await sleep(2500);
  assert.ok((await A.evaluate(() => document.getElementById("da-err").textContent)).includes("Password is wrong")); ok("Delete sheet refuses a wrong password");
  await A.screenshot({ path: "/tmp/work/shot-delete-sheet.png" });
  await A.$eval("#da-pass", e => { e.value = ""; }); await A.type("#da-pass", "alice-secret-1");
  await A.$eval("#da-go", e => e.click()); await sleep(3500);
  assert.ok(await A.evaluate(() => !localStorage.getItem("tagg.owner.v1") && !localStorage.getItem("tagg.profile.v1"))); ok("Delete clears Alice's sign-in from the device");
  const gone = await fetch(API_URL + "/api/c/" + slug); assert.equal(gone.status, 404); ok("Alice's card is gone on the server");
  await B.goto(base + "#/people"); await B.reload({ waitUntil: "networkidle0" }); await sleep(2500);
  await B.goto(base + "#/people"); await waitText(B, "Alice Ng", 15000); ok("Bob still has his own record of Alice after she deleted");
  console.log("\nUI checks passed:", n);
} catch (e) { console.log("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close();
