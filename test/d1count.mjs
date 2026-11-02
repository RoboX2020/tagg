// Measures D1 queries and rows read/written per user action, to size the free tier (100k rows written + 5M rows read per day).
// Run: node test/d1count.mjs
import { start, stats } from "./serve-d1.mjs";
const { srv, url, env } = await start(8797);
env.SIGNUP_PER_HOUR = "200";
const sent = []; env.MAIL_SINK = async (...a) => { sent.push(a); };
async function call(m, p, b, t) { const h = { "content-type": "application/json" }; if (t) h.Authorization = "Bearer " + t; const r = await fetch(url + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }); return r.json().catch(() => ({})); }
const rows = [];
async function step(name, fn) {
  const q0 = stats.queries, r0 = stats.rowsRead, w0 = stats.rowsWritten;
  const out = await fn();
  await new Promise(r => setTimeout(r, 50)); // let waitUntil work land
  rows.push([name, stats.queries - q0, stats.rowsRead - r0, stats.rowsWritten - w0]);
  return out;
}
const A = await step("signup (email)", () => call("POST", "/api/auth/signup", { email: "a@x.io", password: "password123", name: "Ann" }));
const ca = await step("create card", () => call("POST", "/api/card", { ownerToken: A.ownerToken, card: { name: "Ann", headline: "Maker", detail: "Builds", email: "a@x.io", links: {} } }));
await step("request email code", () => call("POST", "/api/auth/email/request", null, A.ownerToken));
const code = sent[0][2].match(/\d{6}/)[0];
await step("confirm code (+welcome)", () => call("POST", "/api/auth/email/confirm", { code }, A.ownerToken));
await step("anonymous card view (guarded)", () => call("GET", "/api/c/" + ca.slug));
await step("public scan ping", () => call("POST", "/api/scan", { slug: ca.slug }));
const B = await call("POST", "/api/auth/signup", { email: "b@x.io", password: "password123", name: "Bo" });
await call("POST", "/api/card", { ownerToken: B.ownerToken, card: { name: "Bo", headline: "Dev", detail: "Codes", email: "b@x.io", links: {} } });
await step("connect request", () => call("POST", "/api/connect", { slug: ca.slug, requesterToken: B.ownerToken, event: "x" }));
const ib = await step("inbox read (one 4s poll)", () => call("GET", "/api/inbox", null, A.ownerToken));
await step("accept request (mutual save)", () => call("POST", "/api/inbox/respond", { id: ib.requests[0].id, accept: true }, A.ownerToken));
await step("people list", () => call("GET", "/api/people", null, A.ownerToken));
console.log("action".padEnd(30), "queries", "rowsRead", "rowsWritten");
for (const r of rows) console.log(r[0].padEnd(30), String(r[1]).padStart(7), String(r[2]).padStart(9), String(r[3]).padStart(11));
srv.close();
