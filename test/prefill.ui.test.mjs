// Edit screen prefill: name from sign-up is prefilled, email and phone are not; the email button fills it only on tap. Headless Chrome 390 px, synthetic.
import puppeteer from "puppeteer-core"; import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import assert from "node:assert/strict"; import { start } from "./serve.mjs";
const root = path.resolve(import.meta.dirname, "..");
const api = await start(8812); api.env.SIGNUP_PER_HOUR = "200";
const web = http.createServer((q, r) => { const f = path.join(root, q.url.split("?")[0] === "/" ? "index.html" : q.url.split("?")[0]); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { "Content-Type": { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" }[path.extname(f)] || "application/octet-stream" }); r.end(fs.readFileSync(f)); }).listen(8813);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const a = await (await fetch("http://localhost:8812/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "pf@tagg-test.invalid", password: "pw-secret-123", name: "Pre Fill" }) })).json();
  const P = await (await browser.createBrowserContext()).newPage(); await P.setViewport({ width: 390, height: 844 });
  await P.evaluateOnNewDocument((tok) => { localStorage.setItem("tagg.api", "http://localhost:8812"); localStorage.setItem("tagg.owner.v1", tok); localStorage.setItem("tagg.profile.v1", JSON.stringify({ email: "pf@tagg-test.invalid", name: "Pre Fill", kind: "email", emailVerified: false })); }, a.ownerToken);
  await P.goto("http://localhost:8813/#/edit", { waitUntil: "networkidle0" }); await sleep(600);
  const v = id => P.$eval("#" + id, e => e.value);
  assert.equal(await v("f-name"), "Pre Fill"); assert.equal(await v("f-email"), ""); assert.equal(await v("f-phone"), ""); console.log("ok - name prefilled, email and phone empty");
  await P.click("#use-signin-email"); assert.equal(await v("f-email"), "pf@tagg-test.invalid"); assert.equal(await P.$("#use-signin-email"), null); console.log("ok - email filled only after tapping the button");
  await P.screenshot({ path: "/tmp/prefill.png" });
} catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
await browser.close(); api.srv.close(); web.close(); process.exit(process.exitCode || 0);
