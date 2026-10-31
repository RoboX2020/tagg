// Intro flow on the Durable Object build (in-process SQLite): simultaneous target accepts, and store failures (before commit / response lost) around forwarding and accepting, with retry after 61 s.
import { DatabaseSync } from "node:sqlite"; import worker, { RateLimiter, Store } from "../worker/worker-do.js";
const realNow = Date.now; let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
function build() {
  const db = new DatabaseSync(":memory:"); const store = new Store({ storage: { sql: { exec(q, ...p) { const st = db.prepare(q); return /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []); } } } });
  const st = { armed: false, n: 0, k: 0, mode: "none" };
  const ns = { idFromName: x => x, get: () => ({ fetch: async (u, init) => { if (st.armed) { st.n++; if (st.n === st.k && st.mode === "before") throw new Error("unreachable"); } const r = await store.fetch(new Request(u, init)); if (st.armed && st.n === st.k && st.mode === "after") throw new Error("lost"); return r; } }) };
  const objs = new Map(); const RL = { idFromName: x => x, get: id => ({ fetch: async (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async q => m.get(q), put: async (q, v) => { m.set(q, v); } } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
  const sent = []; const env = { STORE: ns, RL, GOOGLE_CLIENT_ID: "t", MAIL_SINK: async (...a) => { sent.push(a); } };
  const call = async (m, p, b, t) => { const h = { "content-type": "application/json", "cf-connecting-ip": "8.8.8." + Math.floor(Math.random() * 200) }; if (t) h.Authorization = "Bearer " + t; const bg = []; let r; try { r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, { waitUntil: q => bg.push(q) }); } catch (e) { return { s: 599 }; } await Promise.all(bg); return { s: r.status, ...(await r.json().catch(() => ({}))) }; };
  const raw = async (f) => (await (await store.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops: [f] }) }))).json()).out[0];
  return { st, call, raw, sent };
}
async function setup() {
  const W = build(), { call, raw } = W; for (const k of ["cfg/intro", "cfg/notify", "cfg/notify-scan", "cfg/notify-net"]) await raw({ o: "put", k, v: "on" });
  const mk = async (nm) => { const t = (await call("POST", "/api/owner", {})).ownerToken; const c = await call("POST", "/api/card", { ownerToken: t, card: { name: nm, headline: "Eng", detail: "d", email: nm.toLowerCase() + "@in.invalid", links: {} } }, t); return { t, slug: c.slug }; };
  const save = (a, b) => call("POST", "/api/people", { slug: b.slug, event: "e" }, a.t);
  const A = await mk("DoAl"), M = await mk("DoMi"), T = await mk("DoTa");
  await save(A, M); await save(M, A); await save(M, T); await save(T, M);
  for (const w of [A, M, T]) await call("PUT", "/api/graph/sharing", { on: true }, w.t); await call("PUT", "/api/intro/consent", { on: true }, T.t);
  const cd = (await call("GET", "/api/intro/candidates", null, A.t)).candidates; if (cd.length !== 1) throw new Error("setup: candidate " + cd.length);
  const rq = await call("POST", "/api/intro", { viaPersonId: cd[0].via.personId, targetRef: cd[0].ref, note: "n" }, A.t); if (rq.s !== 200) throw new Error("setup request " + rq.s);
  const id = (await call("GET", "/api/intros", null, M.t)).intros[0].id; return { W, A, M, T, id };
}
const snap = async (X) => { const { W, A, M, T, id } = X; const itr = JSON.parse(await W.raw({ o: "get", k: "intr/" + M.t })).find(x => x.id === id), off = JSON.parse((await W.raw({ o: "get", k: "intf/" + T.t })) || "[]");
  const pa = ((await W.call("GET", "/api/people", null, A.t)).people || []).filter(p => p.card.name === "DoTa").length, pt = ((await W.call("GET", "/api/people", null, T.t)).people || []).filter(p => p.card.name === "DoAl").length;
  return { intr: itr.status, offers: off.filter(o => o.id === id).length, offerStatus: (off.find(o => o.id === id) || {}).status, pa, pt, mails: W.sent.length }; };
const later = async (f) => { Date.now = () => realNow() + 61000; try { return await f(); } finally { Date.now = realNow; } };
// 1) simultaneous target accepts
{ const X = await setup(); const { W, M, T, id } = X; await W.call("POST", "/api/intros/respond", { id, forward: true }, M.t);
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => W.call("POST", "/api/intro-offers/respond", { id, accept: true }, T.t)));
  const s = await snap(X); ok(rs.filter(r => r.s === 200).length === 1, "5 simultaneous accepts: exactly one 200 " + rs.map(r => r.s)); ok(s.pa === 1 && s.pt === 1 && s.offerStatus === "accepted", "one save each side " + JSON.stringify(s)); ok(s.mails === 0, "no mail");
  const X2 = await setup(); await X2.W.call("POST", "/api/intros/respond", { id: X2.id, forward: true }, X2.M.t);
  const rd = await Promise.all([X2.W.call("POST", "/api/intro-offers/respond", { id: X2.id, accept: true }, X2.T.t), X2.W.call("POST", "/api/intro-offers/respond", { id: X2.id, accept: false }, X2.T.t)]);
  const s2 = await snap(X2); ok(rd.filter(r => r.s === 200).length === 1 && ((s2.pa === 1 && s2.offerStatus === "accepted") || (s2.pa === 0 && s2.offerStatus === "declined")), "accept vs decline race ends consistent " + JSON.stringify(s2));
  const X3 = await setup(); const fr = await Promise.all([1, 2, 3].map(() => X3.W.call("POST", "/api/intros/respond", { id: X3.id, forward: true }, X3.M.t)));
  const s3 = await snap(X3); ok(fr.filter(r => r.s === 200).length === 1 && s3.offers === 1 && s3.intr === "forwarded", "3 simultaneous forwards: one offer " + JSON.stringify(s3)); }
// 2) store failures around forwarding
{ const c = await setup(); const ca = c.W.st; ca.armed = true; ca.n = 0; await c.W.call("POST", "/api/intros/respond", { id: c.id, forward: true }, c.M.t); const used = ca.n; ca.armed = false;
  for (const mode of ["before", "after"]) for (let k = 1; k <= used; k++) { const X = await setup(); X.W.st.mode = mode; X.W.st.k = k; X.W.st.n = 0; X.W.st.armed = true;
    await X.W.call("POST", "/api/intros/respond", { id: X.id, forward: true }, X.M.t); X.W.st.armed = false;
    await later(() => X.W.call("POST", "/api/intros/respond", { id: X.id, forward: true }, X.M.t));
    const s = await snap(X), tag = `forward ${mode}@${k}/${used}`; ok(s.intr === "forwarded" && s.offers === 1, tag + " " + JSON.stringify(s)); }
  console.log("forward store calls:", used); }
// 3) store failures around accepting
{ const c = await setup(); await c.W.call("POST", "/api/intros/respond", { id: c.id, forward: true }, c.M.t); const ca = c.W.st; ca.armed = true; ca.n = 0; await c.W.call("POST", "/api/intro-offers/respond", { id: c.id, accept: true }, c.T.t); const used = ca.n; ca.armed = false;
  for (const mode of ["before", "after"]) for (let k = 1; k <= used; k++) { const X = await setup(); await X.W.call("POST", "/api/intros/respond", { id: X.id, forward: true }, X.M.t);
    X.W.st.mode = mode; X.W.st.k = k; X.W.st.n = 0; X.W.st.armed = true; await X.W.call("POST", "/api/intro-offers/respond", { id: X.id, accept: true }, X.T.t); X.W.st.armed = false;
    await later(() => X.W.call("POST", "/api/intro-offers/respond", { id: X.id, accept: true }, X.T.t));
    const s = await snap(X), tag = `accept ${mode}@${k}/${used}`; ok(s.offerStatus === "accepted" && s.pa === 1 && s.pt === 1 && s.mails === 0, tag + " " + JSON.stringify(s)); }
  console.log("accept store calls:", used); }
console.log(`intro DO checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
