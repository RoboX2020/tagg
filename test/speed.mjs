// User-visible timing of the QR scan -> signup -> connect -> accept path. Headless Chrome at phone size, NOT an iPhone.
// Usage: node test/speed.mjs API_URL [runs] [net|none] [cpu]   API must be a STAGING or local API (this creates synthetic accounts).
import puppeteer from "puppeteer-core"; import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
const API = process.argv[2], RUNS = Number(process.argv[3] || 3), NET = process.argv[4] || "none", CPU = Number(process.argv[5] || 1);
if (/tagg-api\./.test(API)) { console.error("refusing: production API"); process.exit(2); }
const root = path.resolve(import.meta.dirname, "..");
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  const t = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/json" }[path.extname(f)] || "application/octet-stream";
  const raw = fs.readFileSync(f), gz = /gzip/.test(q.headers["accept-encoding"] || "") && /^\.(js|html|css|svg)$/.test(path.extname(f)); r.writeHead(200, { "Content-Type": t, ...(gz ? { "Content-Encoding": "gzip" } : {}) }); r.end(gz ? zlib.gzipSync(raw) : raw); }).listen(8801);
const base = "http://localhost:8801/"; const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const text = p => p.evaluate(() => document.body.innerText);
async function until(p, t, ms = 20000) { const t0 = performance.now(); while (performance.now() - t0 < ms) { if ((await text(p)).includes(t)) return performance.now() - t0; await sleep(30); } throw new Error("timeout waiting for: " + t); }
const clickText = (p, sel, t) => p.evaluate((sel, t) => { const e = [...document.querySelectorAll(sel)].find(x => x.textContent.includes(t)); if (!e) throw new Error("no " + t); e.click(); }, sel, t);
async function mk(email) { const ctx = await browser.createBrowserContext(); await ctx.overridePermissions(base, ["geolocation"]); const P = await ctx.newPage(); await P.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await P.evaluateOnNewDocument((a) => { localStorage.setItem("tagg.api", a); }, API); const c = await P.createCDPSession();
  if (NET === "net") await c.send("Network.emulateNetworkConditions", { offline: false, latency: 170, downloadThroughput: 9e6 / 8, uploadThroughput: 1.6e6 / 8 });
  if (CPU > 1) await c.send("Emulation.setCPUThrottlingRate", { rate: CPU }); return P; }
const api = async (m, p, b, t) => (await fetch(API + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();
const RUN = Date.now().toString(36); const res = { coldCard: [], warmCard: [], signup: [], sent: [], accept: [], fcp: [], bytes: [], reqs: [] };
try { for (let i = 0; i < RUNS; i++) {
  const a = await api("POST", "/api/auth/signup", { email: `sa-${RUN}-${i}@tagg-test.invalid`, password: "pw-secret-123", name: "Speed Owner" });
  const card = await api("POST", "/api/card", { ownerToken: a.ownerToken, card: { name: "Speed Owner", headline: "Maker", detail: "Builds", links: {} } }, a.ownerToken);
  const B = await mk(); let bytes = 0, reqs = 0; B.on("response", async r => { reqs++; const l = Number(r.headers()["content-length"] || 0); bytes += l; });
  const t0 = performance.now(); await B.goto(base + "#/c/" + card.slug, { waitUntil: "domcontentloaded" }); await until(B, "Speed Owner"); res.coldCard.push(performance.now() - t0); res.bytes.push(bytes); res.reqs.push(reqs);
  res.fcp.push(await B.evaluate(() => (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime || null));
  const w0 = performance.now(); await B.goto(base + "#/", { waitUntil: "domcontentloaded" }); await B.goto(base + "#/c/" + card.slug, { waitUntil: "domcontentloaded" }); await until(B, "Speed Owner"); res.warmCard.push(performance.now() - w0);
  await B.type("#au-name", "Bob Speed"); await B.type("#au-email", `sb-${RUN}-${i}@tagg-test.invalid`); await B.type("#au-pass", "bob-secret-12"); await B.type("#f-event", "Speed test");
  const s0 = performance.now(); await clickText(B, "button", "Create account and share"); await until(B, "Save your recovery code"); res.signup.push(performance.now() - s0);
  const c0 = performance.now(); await clickText(B, "button", "I saved it"); await until(B, "Shared with Speed Owner"); res.sent.push(performance.now() - c0);
  const A = await mk(); await A.evaluate(() => 0);
  const inbox = await api("GET", "/api/inbox", null, a.ownerToken); const rq = inbox.requests && inbox.requests[0];
  const q0 = performance.now(); const r = await api("POST", "/api/inbox/respond", { id: rq.id, accept: true }, a.ownerToken); res.accept.push(performance.now() - q0);
  await B.close(); await A.close();
} } catch (e) { console.error("FAIL", e.message); }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
const row = (k, a) => `${k.padEnd(10)} n=${a.length} min ${pct(a, 0)} median ${pct(a, 0.5)} max ${pct(a, 1)} ms`;
console.log(`profile: net=${NET} cpu=${CPU}x api=${API.replace(/https?:\/\//, "")}`); for (const k of ["coldCard", "warmCard", "signup", "sent", "accept", "fcp"]) console.log(row(k, res[k].filter(x => x != null)));
console.log("cold load: requests", res.reqs.join(","), "bytes with content-length", res.bytes.join(","));
await browser.close(); web.close(); process.exit(0);
