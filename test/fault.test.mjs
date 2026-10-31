// Fault injection on inbox accept/decline: crash (throw) at each write after the claim, then retry after 61 s. Notifications on, mail captured by a stub (no real addresses).
import worker, { RateLimiter } from "../worker/worker.js"; import { MemoryKV } from "./kv-shim.mjs";
const realNow = Date.now; let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
const op0 = (kv, k, v) => MemoryKV.prototype.put.call(kv, k, v);
async function scenario(accept, failAt) {
  const kv = new MemoryKV(), sent = []; const BG = []; const objs = new Map();
  const RL = { idFromName: n => n, get: id => ({ fetch: async (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async k => m.delete(k) } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
  const env = { KV: kv, RL, GOOGLE_CLIENT_ID: "t", MAIL_SINK: async (...a) => { sent.push(a); } };
  for (const k of ["cfg/notify", "cfg/notify-scan", "cfg/notify-net"]) await kv.put(k, "on");
  const ctx = { waitUntil: p => BG.push(p) };
  const call = async (m, p, b, t) => { const h = { "content-type": "application/json", "cf-connecting-ip": "5.5.5." + Math.floor(Math.random() * 200) }; if (t) h.Authorization = "Bearer " + t; const r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, ctx); await Promise.all(BG.splice(0)); return { s: r.status, ...(await r.json().catch(() => ({}))) }; };
  const A = await call("POST", "/api/auth/signup", { email: "a@x.io", password: "password123", name: "Ann" }); await call("POST", "/api/card", { ownerToken: A.ownerToken, card: { name: "Ann", headline: "M", detail: "d", email: "a@x.io", links: {} } });
  const B = await call("POST", "/api/auth/signup", { email: "b@x.io", password: "password123", name: "Bo" }); const cb = await call("POST", "/api/card", { ownerToken: B.ownerToken, card: { name: "Bo", headline: "D", detail: "d", email: "b@x.io", links: {} } });
  const ca = await call("GET", "/api/me", null, A.ownerToken); const slugA = ca.slug || (await call("POST", "/api/card", { ownerToken: A.ownerToken, card: { name: "Ann", headline: "M", detail: "d", email: "a@x.io", links: {} } })).slug;
  await call("POST", "/api/connect", { slug: slugA, requesterToken: B.ownerToken, event: "x" });
  { const pr = JSON.parse(await kv.get("prof/" + B.ownerToken)); pr.emailVerified = true; await op0(kv, "prof/" + B.ownerToken, JSON.stringify(pr)); }
  const ib = await call("GET", "/api/inbox", null, A.ownerToken); const id = ib.requests[0].id;
  // arm: count writes from now; throw on the failAt-th (0 = never)
  let n = 0; const op = kv.put.bind(kv); kv.put = async (k, v, o) => { n++; if (failAt && n === failAt) throw new Error("injected"); return op(k, v, o); };
  const r1 = await call("POST", "/api/inbox/respond", { id, accept }, A.ownerToken); const writes = n;
  kv.put = op; Date.now = () => realNow() + 61000;
  const r2 = await call("POST", "/api/inbox/respond", { id, accept }, A.ownerToken); Date.now = realNow;
  const ppA = (await call("GET", "/api/people", null, A.ownerToken)).people || [], ppB = (await call("GET", "/api/people", null, B.ownerToken)).people || [];
  const nt = JSON.parse((await kv.get("nt/" + B.ownerToken)) || "[]").filter(x => x.type === "connected");
  const st = JSON.parse(await kv.get("cin/" + A.ownerToken)).find(x => x.id === id).status;
  const mailsToB = sent.filter(a => /b@x\.io/.test(String(a[0]))).length;
  return { r1: r1.s, r2: r2.s, writes, ppA: ppA.length, ppB: ppB.length, nt: nt.length, st, mailsToB };
}
for (const accept of [true, false]) {
  const base = await scenario(accept, 0); const W = base.writes;
  for (let f = 1; f <= W; f++) {
    const r = await scenario(accept, f); const tag = (accept ? "accept" : "decline") + " crash@write" + f + "/" + W;
    ok(r.st === (accept ? "accepted" : "declined"), tag + " final status " + r.st + " r1=" + r.r1 + " r2=" + r.r2);
    ok(r.ppA === (accept ? 1 : 0) && r.ppB === (accept ? 1 : 0), tag + " people " + r.ppA + "/" + r.ppB);
    ok(r.nt <= 1, tag + " connected alerts " + r.nt);
    ok(r.mailsToB <= (base.mailsToB), tag + " mails " + r.mailsToB + " vs clean " + base.mailsToB);
  }
  console.log((accept ? "accept" : "decline"), "clean run: writes", W, JSON.stringify(base));
}
console.log(`fault checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
