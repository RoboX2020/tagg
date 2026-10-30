// Browser test of the chat (Ask) screen with voice, and the agent-connection panel. Run: node test/chat.ui.test.mjs
// Speech APIs are mocked (headless Chrome has none). Real iPhone Safari is NOT covered.
import puppeteer from "puppeteer-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8791);
const API_URL = "http://localhost:8791";
api.env.SIGNUP_PER_HOUR = "200";
let lastPrompt = "";
api.env.AI = { run: async (m, o) => { lastPrompt = o.messages[0].content; 
  if (/who else/.test(o.messages[0].content.split("QUESTION:")[1] || "") ) return { response: /EARLIER IN THIS CONVERSATION[\s\S]*who works on robotics[\s\S]*You met Alice Ng/.test(o.messages[0].content) ? "Follow-up saw the earlier turn." : "NO CONTEXT" };
  return { response: "You met Alice Ng at Cal Hacks. She works on robotics." }; } };
const web = http.createServer((q, r) => {
  const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]);
  if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream";
  r.writeHead(200, { "Content-Type": t }); r.end(fs.readFileSync(f));
}).listen(8792);
const base = "http://localhost:8792/";
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
let n = 0; const ok = (m) => console.log("ok -", m, ++n && "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = p => p.evaluate(() => document.body.innerText);
async function waitText(p, t, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { if ((await text(p)).includes(t)) return; await sleep(150); } throw new Error("timeout: " + t + "\n---\n" + (await text(p))); }
async function call(method, p, body, tok) { const r = await fetch(API_URL + p, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }
try {
  // Seed: Alice has a card; Bob signs in on the page and has saved Alice with a private note.
  const a = await call("POST", "/api/auth/signup", { email: "a@tagg-test.invalid", password: "alice-secret-1", name: "Alice Ng" });
  const card = await call("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Alice Ng", headline: "Robotics", links: {} } });
  const b = await call("POST", "/api/auth/signup", { email: "b@tagg-test.invalid", password: "bob-secret-12", name: "Bob Li" });
  await call("POST", "/api/card", { ownerToken: b.ownerToken, card: { name: "Bob Li", headline: "ML", links: {} } });
  await call("POST", "/api/people", { slug: card.slug, event: "Cal Hacks", note: "private note xyz" }, b.ownerToken);
  const ctx = await browser.createBrowserContext();
  const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844 });
  P.on("pageerror", e => console.log("PAGEERROR", e.message));
  await P.evaluateOnNewDocument((api, tok, prof) => {
    localStorage.setItem("tagg.api", api); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify(prof));
    localStorage.setItem("tagg.consent.ask", "1"); localStorage.setItem("tagg.card.v1", JSON.stringify({ name: "Bob Li", headline: "ML", links: {} })); localStorage.setItem("tagg.slug.v1", "bobli");
    window.__spoken = [];
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    Object.defineProperty(window, "speechSynthesis", { value: { speak: u => window.__spoken.push(u.text), cancel() {} }, configurable: true });
    window.SpeechRecognition = function () { this.start = () => { setTimeout(() => { this.onresult({ results: [[{ transcript: "who works on robotics" }]] }); this.onend(); }, 50); }; this.stop = () => {}; };
  }, API_URL, b.ownerToken, { email: "b@tagg-test.invalid", name: "Bob Li", kind: "email", emailVerified: false });
  await P.goto(base + "#/ask", { waitUntil: "networkidle0" }); await sleep(800);
  assert.ok(await P.$("#mic")); ok("mic button shown when speech recognition exists");
  await P.click("#mic"); await sleep(300);
  assert.equal(await P.$eval("#q", e => e.value), "who works on robotics"); ok("voice input fills the question");
  await P.click("#speak");
  await P.click("#go"); await waitText(P, "You met Alice Ng at Cal Hacks");
  assert.ok(lastPrompt.includes("Alice Ng") && lastPrompt.includes("private note xyz")); ok("Ask retrieves the saved person server-side");
  assert.deepEqual(await P.evaluate(() => window.__spoken), ["You met Alice Ng at Cal Hacks. She works on robotics."]); ok("answer is spoken only when Read aloud is on");
  await P.type("#q", "and who else?"); await P.click("#go"); await waitText(P, "Follow-up saw the earlier turn.");
  ok("a context-dependent follow-up reaches the model with the earlier turns");
  assert.equal(await P.$$eval(".bubble", e => e.length), 4); ok("conversation keeps both turns");
  await P.screenshot({ path: "/tmp/work/shot-chat.png" });
  await P.type("#q", "Who did I meet from CAL HAKS"); await P.click("#go"); await waitText(P, "Search HACKS instead of HAKS");
  ok("a misheard word shows a labelled suggestion button, not a silent correction");
  assert.ok((await text(P)).includes("not a confirmed match"));
  await P.screenshot({ path: "/tmp/work/shot-didyoumean.png" });
  await P.click(".sugg"); await sleep(800);
  assert.ok((await P.$$eval(".bubble.me", e => e.map(x => x.textContent))).some(s => /HACKS/.test(s))); ok("tapping the suggestion asks the corrected question visibly");
  // Settings tab
  await P.goto(base + "#/settings"); await sleep(600);
  assert.equal(await P.$$eval(".tabbar .tab", e => e.length), 5); ok("five tabs in the bottom bar");
  assert.ok((await P.$eval(".tab.active", e => e.getAttribute("aria-current"))) === "page" && (await text(P)).includes("Delete account")); ok("Settings is the current page and holds account deletion");
  const fits = await P.evaluate(() => [...document.querySelectorAll(".tabbar .tab")].every(t => t.scrollWidth <= t.clientWidth + 1 && t.getBoundingClientRect().width >= 60 && t.getBoundingClientRect().height >= 44));
  assert.ok(fits); ok("five tabs fit at 390px with 44px touch targets");
  await P.screenshot({ path: "/tmp/work/shot-settings.png" });
  await P.goto(base + "#/"); await sleep(800);
  assert.ok(/connect tagg to your ai/i.test(await text(P)) && !/delete account/i.test(await text(P))); ok("home keeps only a teaser; deletion lives in Settings");
  await P.screenshot({ path: "/tmp/work/shot-home-new.png", fullPage: true });
  await P.goto(base + "#/settings"); await P.reload({ waitUntil: "networkidle0" });
  // Agent panel
  await P.goto(base + "#/settings"); await P.reload({ waitUntil: "networkidle0" }); await P.waitForSelector("#agname", { timeout: 15000 });
  await P.type("#agname", "My agent"); await P.click("#agadd"); await waitText(P, "It is shown once");
  const tok = await P.$eval("#tokval", e => e.textContent);
  assert.ok(tok.startsWith("tgm_")); ok("connection key is shown once on creation");
  await P.$eval("#agentpanel", e => e.scrollIntoView()); await sleep(200); await P.screenshot({ path: "/tmp/work/shot-agent-once.png" });
  await P.click("#tokdone"); await sleep(600);
  assert.ok(!(await text(P)).includes(tok) && (await text(P)).includes("My agent")); ok("key disappears after dismissal; connection stays listed");
  const r = await fetch(API_URL + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_people", arguments: { query: "cal hacks" } } }) });
  const body = await r.json(); assert.ok(JSON.stringify(body).includes("Alice Ng") && !JSON.stringify(body).includes("private note xyz")); ok("an external agent using the key finds Alice, no private note");
  await P.$eval("#agentpanel", e => e.scrollIntoView()); await sleep(200); await P.screenshot({ path: "/tmp/work/shot-agent-list.png" });
  await P.click("[data-rev]"); await sleep(800);
  assert.ok((await text(P)).includes("No agents connected")); ok("Remove revokes the connection in the UI");
  const r2 = await fetch(API_URL + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r2.status, 401); ok("the removed key is rejected");
  console.log("\nChat UI checks passed:", n);
} catch (e) { console.log("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close();
