import worker, { RateLimiter } from "../worker/worker.js"; import { MemoryKV } from "./kv-shim.mjs";
const kv = new MemoryKV(), sent = [], BG = [], objs = new Map();
const RL = { idFromName: n => n, get: id => ({ fetch: async (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => m.set(k, v), delete: async k => m.delete(k) } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
const env = { KV: kv, RL, GOOGLE_CLIENT_ID: "t", MAIL_SINK: async (...a) => sent.push(a) }; const ctx = { waitUntil: p => BG.push(p) };
const call = async (m, p, b, t) => { const h = { "content-type": "application/json", "cf-connecting-ip": "6.6.6.6" }; if (t) h.Authorization = "Bearer " + t; const r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, ctx); await Promise.all(BG.splice(0)); return { s: r.status, ...(await r.json().catch(() => ({}))) }; };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
const mk = async (n) => { const u = await call("POST", "/api/auth/signup", { email: n + "@x.io", password: "password123", name: n }); const c = await call("POST", "/api/card", { ownerToken: u.ownerToken, card: { name: n, headline: "h", detail: "d", email: n + "@x.io", links: { linkedin: "https://linkedin.com/in/" + n } } }); return { t: u.ownerToken, slug: c.slug }; };
const save = async (a, b) => { await call("POST", "/api/scan", { slug: b.slug }); const r = await call("POST", "/api/people/save", { slug: b.slug }, a.t); return r; };
const A = await mk("alice"), M = await mk("mia"), T = await mk("tara");
// make people lists by connect+accept both directions
const link = async (x, y) => { await call("POST", "/api/connect", { slug: y.slug, requesterToken: x.t, event: "e" }); const ib = await call("GET", "/api/inbox", null, y.t); for (const r of ib.requests || []) await call("POST", "/api/inbox/respond", { id: r.id, accept: true }, y.t); };
await link(A, M); await link(M, T);
const peopleA = (await call("GET", "/api/people", null, A.t)).people || []; const viaId = (peopleA.find(p => p.slug === M.slug) || {}).id;
const ntBefore = (await kv.get("nt/" + M.t)) || "", mailBefore = sent.length;
let r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: T.slug }, A.t); ok(r.s === 404, "flag off: 404 " + r.s);
ok(!(await kv.get("intr/" + M.t)), "flag off: nothing stored");
await kv.put("cfg/intro", "on");
r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: T.slug }, undefined); ok(r.s === 401, "unauthenticated 401");
r = await call("POST", "/api/intro", { viaPersonId: "nope", targetSlug: T.slug }, A.t); ok(r.s === 404, "unknown via 404");
r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: A.slug }, A.t); ok(r.s === 404, "cannot target self " + r.s);
r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: "zzzzzzzz" }, A.t); ok(r.s === 404, "target not saved by middle 404");
r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: T.slug, note: "hi" }, A.t); ok(r.s === 200 && !r.duplicate, "valid intro stored " + r.s);
r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: T.slug }, A.t); ok(r.s === 200 && r.duplicate, "duplicate suppressed");
const L = JSON.parse(await kv.get("intr/" + M.t) || "[]"); ok(L.length === 1 && L[0].requesterSlug === A.slug && L[0].targetSlug === T.slug, "one record in middle's intro list");
ok(((await kv.get("nt/" + M.t)) || "") === ntBefore, "no in-app alert created"); ok(sent.length === mailBefore, "no email sent");
ok(!(await kv.get("intr/" + T.t)) && !(await kv.get("intr/" + A.t)), "nothing in target or requester lists");
// a stranger (not saved by middle) cannot use middle
const S = await mk("sam"); r = await call("POST", "/api/intro", { viaPersonId: viaId, targetSlug: T.slug }, S.t); ok(r.s === 404 || r.s === 403, "stranger cannot use someone else's via " + r.s);
console.log(`intro checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
