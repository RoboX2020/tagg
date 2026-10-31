// Counts KV reads/writes/lists and rate-limiter (Durable Object) hits per user action, to size the free tier. Run: node test/opcount.mjs
import worker, { RateLimiter } from "../worker/worker.js";
import { MemoryKV } from "./kv-shim.mjs";
var BG = []; const kv = new MemoryKV(); const c = { r: 0, w: 0, l: 0, d: 0, do: 0 };
const og = kv.get.bind(kv), op = kv.put.bind(kv), ol = kv.list.bind(kv), od = kv.delete.bind(kv);
kv.get = async (k) => { c.r++; return og(k); }; kv.put = async (k, v, o) => { c.w++; (globalThis.WK ||= []).push(k.replace(/[A-Za-z0-9_-]{12,}/g, "<id>")); return op(k, v, o); }; kv.list = async (o) => { c.l++; return ol(o); }; kv.delete = async (k) => { c.d++; return od(k); };
const objs = new Map();
const RL = { idFromName: n => n, get: id => ({ fetch: (u, init) => { c.do++; if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
const sent = []; const env = { KV: kv, RL, GOOGLE_CLIENT_ID: "t", MAIL_SINK: async (...a) => { sent.push(a); } };
await kv.put("cfg/notify", "on"); await kv.put("cfg/notify-scan", "on"); await kv.put("cfg/notify-net", "on");
async function call(m, p, b, t) { const h = { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5" }; if (t) h.Authorization = "Bearer " + t; const r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, { waitUntil: p => BG.push(p) }); return r.json().catch(() => ({})); }
const rows = [];
async function step(name, fn) { globalThis.WK = []; Object.assign(c, { r: 0, w: 0, l: 0, d: 0, do: 0 }); const t = performance.now(); const out = await fn(); await Promise.all(BG.splice(0)); rows.push([name + "  [" + (globalThis.WK || []).join(" ") + "]", c.r, c.w, c.l, c.do, Math.round(performance.now() - t)]); return out; }
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
const ib = await step("inbox read", () => call("GET", "/api/inbox", null, A.ownerToken));
await step("accept request", () => call("POST", "/api/inbox/respond", { id: ib.requests[0].id, accept: true }, A.ownerToken));
await step("people list", () => call("GET", "/api/people", null, A.ownerToken));
await step("graph (map)", () => call("GET", "/api/graph", null, A.ownerToken));
await step("notify list", () => call("GET", "/api/notify", null, A.ownerToken));
await step("me", () => call("GET", "/api/me", null, A.ownerToken));
await step("login", () => call("POST", "/api/auth/login", { email: "a@x.io", password: "password123" }));
console.log("action".padEnd(26) + "kvR kvW kvL  DO  ms");
for (const r of rows) console.log(r[0].padEnd(26) + r.slice(1).map(x => String(x).padStart(3)).join(" "));
