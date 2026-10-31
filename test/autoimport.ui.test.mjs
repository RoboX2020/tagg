// Browser test of auto-import on adding an own LinkedIn link. Apify is mocked (no spend). Chrome at phone size; real iPhone Safari NOT covered.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8793); const API_URL = "http://localhost:8793";
api.env.SIGNUP_PER_HOUR = "200"; api.env.APIFY_ENABLED = "1"; api.env.APIFY_TOKEN = "mock";
const realFetch = globalThis.fetch; let apifyCalls = 0;
let ghCalls = 0;
globalThis.fetch = async (u, init) => { if (String(u).includes("api.github.com/users/")) { ghCalls++; return new Response(JSON.stringify({ login: "sam-gh", name: "Sam Rivera", bio: "Builds robots", company: "ASU", location: "Tempe", followers: 5, public_repos: 7, avatar_url: null }), { status: 200 }); } if (String(u).includes("api.apify.com")) { apifyCalls++; return new Response(JSON.stringify([{ headline: "Robotics engineering student", experience: [{ position: "Lab Assistant", companyName: "ASU" }], education: [{ schoolName: "Arizona State University" }], location: { linkedinText: "Phoenix, Arizona" } }]), { status: 200 }); } return realFetch(u, init); };
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream"; r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f)); }).listen(8794);
const base = "http://localhost:8794/";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let n = 0; const ok = (m) => console.log("ok -", m, ++n && "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = p => p.evaluate(() => document.body.innerText);
async function waitText(p, t, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if ((await text(p)).includes(t)) return; await sleep(150); } throw new Error("timeout: " + t + "\n---\n" + (await text(p))); }
async function call(method, p, body, tok) { const r = await realFetch(API_URL + p, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }
const shots = process.env.SHOTS || "";
try {
  const b = await call("POST", "/api/auth/signup", { email: "ai@tagg-test.invalid", password: "auto-secret-12", name: "Sam Rivera" });
  const card = await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Sam Rivera", headline: "", links: {} } }, b.ownerToken);
  const ctx = await browser.createBrowserContext(); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok, slug) => { localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.slug.v1", slug);
    localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "ai@tagg-test.invalid", name: "Sam Rivera", kind: "email", emailVerified: false }));
    localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Sam Rivera", headline: "", links: {} })); }, API_URL, b.ownerToken, card.slug);
  await P.goto(base + "#/edit", { waitUntil: "networkidle0" }); await sleep(600);
  await P.type("#f-linkedin", "linkedin.com/in/sam-rivera");
  await P.click("#save"); await waitText(P, "Fill your card from LinkedIn?");
  assert.equal(apifyCalls, 0); ok("saving a new LinkedIn link shows the notice first and imports nothing yet");
  assert.equal(await P.$eval("#ai-own", e => e.checked), false); assert.equal(await P.$eval("#ai-yes", e => e.disabled), true); ok("checkbox is not pre-ticked and import is disabled until ticked");
  const t = await text(P); assert.ok(/shared card/.test(t) && /connect with/.test(t) && /edit or remove/.test(t) && /not verified/.test(t)); ok("notice says it fills the shared card, reaches connections, is editable and unverified");
  if (shots) { await sleep(900); await P.screenshot({ path: shots + "/auto-1-notice.png" }); }
  await P.click("#ai-own"); assert.equal(await P.$eval("#ai-yes", e => e.disabled), false);
  P.on("response", async r => { if (r.url().includes("/auto") && r.request().method()==="POST") console.log("AUTO", r.status(), (await r.text()).slice(0,200)); }); await P.click("#ai-yes"); await waitText(P, "Imported from LinkedIn"); assert.equal(apifyCalls, 1);
  const tt = await text(P); assert.ok(tt.includes("Arizona State University") && tt.includes("Lab Assistant")); ok("after accepting, details fill in and show on the edit page");
  const pub = await call("GET", "/api/c/" + card.slug); assert.equal(pub.enriched.linkedin.source, "linkedin-link-import"); assert.equal(pub.enriched.linkedin.autoImported, true); ok("stored on the shared card with provenance");
  if (shots) { await P.evaluate(() => document.getElementById("liimport").scrollIntoView()); await sleep(300); await P.screenshot({ path: shots + "/auto-2-filled.png" }); }
  await P.click("#li-edit"); await waitText(P, "Cleared details stay cleared"); await P.$eval("#li-location", e => e.value = ""); 
  if (shots) await P.screenshot({ path: shots + "/auto-3-edit.png" });
  await P.click("#li-add"); await sleep(800);
  const pub2 = await call("GET", "/api/c/" + card.slug); assert.equal(pub2.enriched.linkedin.location, ""); assert.ok(pub2.enriched.linkedin.suppressed.includes("location")); ok("owner edit saved; cleared field recorded as cleared");
  await P.click("#li-remove"); await sleep(700); const pub3 = await call("GET", "/api/c/" + card.slug); assert.ok(!pub3.enriched || !pub3.enriched.linkedin); ok("owner can remove imported details");
  // GitHub: notice, import, edit, remove.
  await sleep(4000); await P.type("#f-github", "github.com/sam-gh"); await P.click("#save"); await waitText(P, "Fill your card from GitHub?");
  assert.equal(ghCalls, 0); assert.equal(await P.$eval("#ai-own", e => e.checked), false); assert.equal(await P.$eval("#ai-yes", e => e.disabled), true); ok("a new GitHub link shows its own notice, unticked, import disabled, nothing read yet");
  assert.ok(/public GitHub profile/.test(await text(P)) && /connect with/.test(await text(P)));
  if (shots) { await sleep(900); await P.screenshot({ path: shots + "/gh-1-notice.png" }); }
  await P.click("#ai-own"); await P.click("#ai-yes"); await waitText(P, "Imported from GitHub"); assert.equal(ghCalls, 1);
  ok("accepting imports the public GitHub profile and shows it with edit and remove");
  if (shots) { await P.evaluate(() => document.getElementById("ghimport").scrollIntoView()); await sleep(300); await P.screenshot({ path: shots + "/gh-2-filled.png" }); }
  await P.click("#gh-edit"); await P.$eval("#gh-bio", e => e.value = ""); await P.click("#gh-save"); await sleep(800);
  const gp = await call("GET", "/api/c/" + card.slug); assert.equal(gp.enriched.github.bio, null); assert.ok(gp.enriched.github.suppressed.includes("bio")); ok("GitHub edit saved, cleared field stays cleared");
  await P.click("#gh-remove"); await sleep(800); const gp2 = await call("GET", "/api/c/" + card.slug); assert.ok(!gp2.enriched || !gp2.enriched.github); ok("GitHub details removed");
  // Saving again with the same link must not ask or re-import.
  await P.click("#save"); await sleep(800);
  assert.ok(!(await text(P)).includes("Fill your card from LinkedIn?") && apifyCalls === 1); ok("saving again with the same link neither asks nor re-imports");
  console.log("calls", apifyCalls);
  // Existing users who never saw the notice are untouched: an old record has no auto import.
  const other = await call("POST", "/api/auth/signup", { email: "old@tagg-test.invalid", password: "old-secret-123", name: "Old User" });
  await call("POST", "/api/card", { ownerToken: other.ownerToken, card: { name: "Old User", headline: "", links: { linkedin: "https://linkedin.com/in/old-user" } } }, other.ownerToken);
  assert.equal(apifyCalls, 1); ok("a link already on someone's card triggers no import without their notice");
  console.log("\nAuto-import UI checks passed:", n);
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
