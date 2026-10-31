// Fault injection on the Durable Object build: the k-th store call during accept/decline either fails BEFORE it commits or commits and then the response is LOST.
// Also models a mail provider that accepted the message but the acknowledgement was lost. Synthetic transport only. Run: node test/fault-do.test.mjs
import { DatabaseSync } from "node:sqlite"; import worker, { RateLimiter, Store } from "../worker/worker-do.js";
const realNow = Date.now; let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
async function scenario(accept, mode, k) {
  const db = new DatabaseSync(":memory:"); const store = new Store({ storage: { sql: { exec(q, ...p) { const st = db.prepare(q); return /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []); } } } });
  let armed = false, n = 0, calls = 0; const sent = [];
  const ns = { idFromName: x => x, get: () => ({ fetch: async (u, init) => { if (armed) { n++; if (n === k && mode === "before") throw new Error("store unreachable"); } calls++; const r = await store.fetch(new Request(u, init)); if (armed && n === k && mode === "after") throw new Error("response lost"); return r; } }) };
  const objs = new Map(); const RL = { idFromName: x => x, get: id => ({ fetch: async (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async q => m.get(q), put: async (q, v) => { m.set(q, v); } } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
  let mailMode = mode === "mailack" && armed; const env = { STORE: ns, RL, GOOGLE_CLIENT_ID: "t", MAIL_SINK: async (...a) => { sent.push(a); if (mode === "mailack" && armed && !env._thrown) { env._thrown = 1; throw new Error("ack lost"); } } };
  const call = async (m, p, b, t) => { const h = { "content-type": "application/json", "cf-connecting-ip": "7.7.7." + Math.floor(Math.random() * 200) }; if (t) h.Authorization = "Bearer " + t; const bg = []; let r; try { r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, { waitUntil: q => bg.push(q) }); } catch (e) { return { s: 599 }; } await Promise.all(bg); return { s: r.status, ...(await r.json().catch(() => ({}))) }; };
  const raw = async (f) => (await (await store.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops: [f] }) }))).json()).out[0];
  const put = (kk, v) => raw({ o: "put", k: kk, v });
  for (const kk of ["cfg/notify", "cfg/notify-scan", "cfg/notify-net"]) await put(kk, "on");
  const mk = async (nm) => { const t = (await call("POST", "/api/auth/signup", { email: nm.toLowerCase() + "@in.invalid", password: "password123", name: nm })).ownerToken; const c = await call("POST", "/api/card", { ownerToken: t, card: { name: nm, headline: "E", detail: "d", email: nm.toLowerCase() + "@in.invalid", links: {} } }, t); return { t, slug: c.slug }; };
  const A = await mk("FaA"), B = await mk("FaB");
  { const pr = JSON.parse(await raw({ o: "get", k: "prof/" + B.t })); pr.emailVerified = true; await put("prof/" + B.t, JSON.stringify(pr)); }
  await call("POST", "/api/connect", { slug: A.slug, requesterToken: B.t, event: "x" });
  const id = (await call("GET", "/api/inbox", null, A.t)).requests[0].id;
  armed = true; n = 0; const r1 = await call("POST", "/api/inbox/respond", { id, accept }, A.t); const used = n; armed = false;
  Date.now = () => realNow() + 61000; const r2 = await call("POST", "/api/inbox/respond", { id, accept }, A.t); Date.now = realNow;
  const ppA = (await call("GET", "/api/people", null, A.t)).people || [], ppB = (await call("GET", "/api/people", null, B.t)).people || [];
  const nt = JSON.parse((await raw({ o: "get", k: "nt/" + B.t })) || "[]").filter(x => x.type === "connected").length;
  const st = JSON.parse(await raw({ o: "get", k: "cin/" + A.t })).find(x => x.id === id).status;
  return { r1: r1.s, r2: r2.s, used, ppA: ppA.length, ppB: ppB.length, nt, st, mails: sent.filter(a => /fab@/.test(String(a[0]))).length };
}
for (const accept of [true, false]) {
  const clean = await scenario(accept, "none", 0); console.log((accept ? "accept" : "decline"), "clean:", JSON.stringify(clean));
  for (const mode of ["before", "after"]) for (let k = 1; k <= clean.used; k++) {
    const r = await scenario(accept, mode, k), tag = `${accept ? "accept" : "decline"} ${mode}@call${k}/${clean.used}`;
    ok(r.st === (accept ? "accepted" : "declined"), tag + " final " + r.st + " r1=" + r.r1 + " r2=" + r.r2);
    ok(r.ppA === clean.ppA && r.ppB === clean.ppB, tag + ` people ${r.ppA}/${r.ppB}`); ok(r.nt <= 1, tag + " alerts " + r.nt);
    if (r.mails > clean.mails) console.log("NOTE duplicate email", tag, r.mails, "vs", clean.mails);
  }
}
{ const r = await scenario(true, "mailack", 0); console.log("mail ack lost (provider accepted, ack lost) on accept:", JSON.stringify(r)); ok(r.st === "accepted" && r.ppA === 1 && r.ppB === 1 && r.nt <= 1, "mail ack lost: state consistent"); }
console.log(`DO fault checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
