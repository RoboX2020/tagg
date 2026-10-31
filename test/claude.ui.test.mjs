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
  const CB = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (await fetch(API_URL + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB] }) })).json();
  const { createHash, randomBytes } = await import("node:crypto");
  const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const ver = b64u(randomBytes(32)), ch = b64u(createHash("sha256").update(ver).digest());
  const az = await fetch(API_URL + "/oauth/authorize?" + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, state: "s9", code_challenge: ch, code_challenge_method: "S256" }), { redirect: "manual" });
  const hash = new URL(az.headers.get("location")).hash;
  const A = await mkPage(a.ownerToken, "ca@tagg-test.invalid", "Pat Owner", 390, 844);
  let hit = null; await A.setRequestInterception(true);
  A.on("request", (r) => { if (r.url().startsWith("https://claude.ai/")) { hit = r.url(); r.abort(); } else r.continue(); });
  await A.goto(base + hash, { waitUntil: "networkidle0" }); await sleep(1500);
  const txt = await A.evaluate(() => document.getElementById("cc").innerText);
  assert.ok(/Let Claude read your Tagg people/.test(txt) && /claude\.ai/.test(txt) && /private notes/.test(txt)); ok("consent screen names Claude and the callback host and offers notes separately");
  if (shots) await A.screenshot({ path: shots + "/claude-consent.png" });
  await A.click("#cc-yes"); await sleep(2000);
  const u = hit && new URL(hit);
  assert.ok(u && u.origin + u.pathname === CB && u.searchParams.get("state") === "s9" && /^tgcode_/.test(u.searchParams.get("code"))); ok("Allow sends the browser to Claude's callback with a code and state");
  const tr = await (await fetch(API_URL + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: CB, client_id: reg.client_id, code_verifier: ver }).toString() })).json();
  assert.ok(/^tgm_/.test(tr.access_token)); ok("the code redeems for a token");
  const S = await mkPage(a.ownerToken, "ca@tagg-test.invalid", "Pat Owner", 390, 844);
  await S.goto(base + "#/settings", { waitUntil: "networkidle0" }); await sleep(2000);
  const st = await S.evaluate(() => { const p = document.getElementById("agentpanel"); return p ? p.innerText : ""; });
  assert.ok(/Add custom connector/.test(st) && /\/api\/mcp/.test(st) && /Claude/.test(st)); ok("Settings shows the three simple Claude steps and the server address, plus the connection just made");
  if (shots) { await S.evaluate(() => document.getElementById("agentpanel").scrollIntoView()); await S.screenshot({ path: shots + "/claude-settings.png" }); }
  console.log("\nClaude UI checks passed:", n);
} catch (e) { console.error("FAIL", e.stack.split("\n").slice(0, 3).join(" | ")); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
