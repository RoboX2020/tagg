import worker, { RateLimiter } from "../worker/worker.js"; import { MemoryKV } from "./kv-shim.mjs";
const kv = new MemoryKV(), sent = [], BG = [], objs = new Map();
const RL = { idFromName: n => n, get: id => ({ fetch: async (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => m.set(k, v), delete: async k => m.delete(k) } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
const env = { KV: kv, RL, GOOGLE_CLIENT_ID: "t", MAIL_SINK: async (...a) => sent.push(a) }; const ctx = { waitUntil: p => BG.push(p) };
const call = async (m, p, b, t) => { const h = { "content-type": "application/json", "cf-connecting-ip": "6.6.6." + Math.floor(Math.random() * 200) }; if (t) h.Authorization = "Bearer " + t; const r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, ctx); await Promise.all(BG.splice(0)); return { s: r.status, ...(await r.json().catch(() => ({}))) }; };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
const mk = async (n, complete = true) => { const t = (await call("POST", "/api/owner", {})).ownerToken; const c = await call("POST", "/api/card", { ownerToken: t, card: { name: n, headline: "Engineer", detail: complete ? "Builds things" : "", email: complete ? n.toLowerCase() + "@in.invalid" : "", links: {} } }, t); return { t, slug: c.slug, name: n }; };
const save = (a, b) => call("POST", "/api/people", { slug: b.slug, event: "e" }, a.t);
const sh = (w, on) => call("PUT", "/api/graph/sharing", { on }, w.t);
const idOf = async (a, b) => ((await call("GET", "/api/people", null, a.t)).people.find(p => p.slug === b.slug) || {}).id;
const intro = (a, via, target, extra = {}) => call("POST", "/api/intro", { viaPersonId: via, targetSlug: target.slug, ...extra }, a.t);
const A = await mk("InAlice"), M = await mk("InMia"), N = await mk("InNoa"), T = await mk("InTara"), H = await mk("InHidden");
await save(A, M); await save(M, A); await save(A, N); await save(N, A); await save(M, T); await save(N, T); await save(M, H);
await kv.put("cfg/intro", "on"); const cons = (w, on = true, headline = false) => call("PUT", "/api/intro/consent", { on, headline }, w.t);
for (const w of [A, M, N, T]) { await sh(w, true); } await sh(H, false); await cons(T); await cons(H); await cons(N);
const viaM = await idOf(A, M), viaN = await idOf(A, N);
const ntM = (await kv.get("nt/" + M.t)) || "", mails = sent.length;
await kv.put("cfg/intro", "off"); let r = await intro(A, viaM, T); ok(r.s === 404, "flag off 404 " + r.s); ok(!(await kv.get("intr/" + M.t)), "flag off stores nothing");
r = await call("GET", "/api/intros", null, M.t); ok(r.s === 404, "flag off list 404"); ok((await call("GET", "/api/intro/config")).enabled === false && (await call("PUT", "/api/intro/consent", { on: true }, T.t)).s === 404, "config says disabled; consent route 404");
await kv.put("cfg/intro", "on");
ok((await intro({ t: "bogus" }, viaM, T)).s === 401, "bad token 401");
// hidden / wrong / cross-owner all return the identical answer
const same = JSON.stringify((await intro(A, viaM, H)));
ok(same === JSON.stringify(await intro(A, viaM, { slug: "zzzzzzzz" })), "hidden target indistinguishable from nonexistent");
ok(JSON.stringify(await intro(A, "nope", T)) === same, "unknown via same answer");
ok(JSON.stringify(await intro(A, viaM, A)) === same, "self target same answer");
ok(JSON.stringify(await intro(A, viaM, M)) === same, "target = via same answer");
const S = await mk("InSam"); ok(JSON.stringify(await intro(S, viaM, T)) === same, "cross-owner via id same answer");
ok(JSON.stringify(await intro(A, viaM, N)) === same, "direct connection is not an intro target");
ok(!(await kv.get("intr/" + M.t)), "nothing stored by refusals");
r = await intro(A, viaM, T, { note: "hi" }); ok(r.s === 200 && !r.duplicate, "valid intro stored " + r.s + JSON.stringify(r));
ok((await intro(A, viaM, T)).duplicate === true, "duplicate same via");
ok((await intro(A, viaN, T)).duplicate === true, "duplicate via a second path suppressed");
ok(JSON.parse(await kv.get("intr/" + M.t)).length === 1 && !(await kv.get("intr/" + N.t)), "exactly one record");
ok(((await kv.get("nt/" + M.t)) || "") === ntM && sent.length === mails, "no alert, no email");
let L = await call("GET", "/api/intros", null, M.t); ok(L.intros && L.intros.length === 1 && L.intros[0].target.name === "InTara", "middle reads entry");
ok((await call("GET", "/api/intros", null, A.t)).intros.length === 0 && (await call("GET", "/api/intros", null, T.t)).intros.length === 0, "requester and target do not see it");
ok((await call("GET", "/api/intros", null, S.t)).intros.length === 0, "other owner sees nothing");
// revoke after request: each of the conditions hides the entry on read
await sh(T, false); L = await call("GET", "/api/intros", null, M.t); ok(L.intros.length === 0, "target opt-out hides it"); await sh(T, true);
L = await call("GET", "/api/intros", null, M.t); ok(L.intros.length === 1, "restored when consent returns");
await sh(M, false); L = await call("GET", "/api/intros", null, M.t); ok(L.intros.length === 0, "middle opt-out hides it"); await sh(M, true);
await sh(A, false); L = await call("GET", "/api/intros", null, M.t); ok(L.intros.length === 0, "requester opt-out hides it"); await sh(A, true);
const ppl = JSON.parse(await kv.get("ppl/" + M.t)); await kv.put("ppl/" + M.t, JSON.stringify(ppl.filter(x => x.slug !== A.slug)));
L = await call("GET", "/api/intros", null, M.t); ok(L.intros.length === 0, "middle un-saving requester hides it"); await kv.put("ppl/" + M.t, JSON.stringify(ppl));
await kv.put("ppl/" + M.t, JSON.stringify(ppl.filter(x => x.slug !== T.slug))); L = await call("GET", "/api/intros", null, M.t); ok(L.intros.length === 0, "middle un-saving target hides it"); await kv.put("ppl/" + M.t, JSON.stringify(ppl));
// requester incomplete cannot request
const I = await mk("InThin"); await save(I, M); await save(M, I); await sh(I, true); { const rec = JSON.parse(await kv.get("card/" + I.slug)); rec.card.detail = ""; rec.card.email = ""; await kv.put("card/" + I.slug, JSON.stringify(rec)); } const vi = ((await call("GET", "/api/people", null, I.t)).people || []).find(p => p.card && p.card.name === "InMia").id; r = await intro(I, vi, T); ok(r.s === 403, "incomplete requester refused " + r.s);

// ---- respond / forward / target consent ----
{
  const A2 = await mk("RqAlice"), M2 = await mk("RqMia"), T2 = await mk("RqTara"), Z = await mk("RqZed");
  await save(A2, M2); await save(M2, A2); await save(M2, T2); await save(T2, M2); await save(M2, Z); await save(Z, M2);
  for (const w of [A2, M2, T2, Z]) await sh(w, true); await call("PUT", "/api/intro/consent", { on: true }, T2.t);
  const via2 = await idOf(A2, M2);
  const nt0 = ["nt/" + T2.t, "nt/" + M2.t, "nt/" + A2.t].map(k => kv.data ? 0 : 0); const mails0 = sent.length;
  await kv.put("cfg/intro", "off");
  ok((await call("POST", "/api/intros/respond", { id: "x", forward: true }, M2.t)).s === 404 && (await call("GET", "/api/intro-offers", null, T2.t)).s === 404 && (await call("POST", "/api/intro-offers/respond", { id: "x", accept: true }, T2.t)).s === 404, "new routes 404 while flag off");
  await kv.put("cfg/intro", "on");
  const rq = await intro(A2, via2, T2, { note: "Would love to meet" }); ok(rq.s === 200, "request ok");
  const id = (await call("GET", "/api/intros", null, M2.t)).intros[0].id;
  ok((await call("POST", "/api/intros/respond", { id, forward: true }, A2.t)).s === 404, "requester cannot respond to intro addressed to via");
  ok((await call("POST", "/api/intros/respond", { id, forward: true }, Z.t)).s === 404, "other owner cannot respond");
  ok((await call("GET", "/api/intro-offers", null, T2.t)).offers.length === 0, "target sees nothing before forward");
  const fw = await call("POST", "/api/intros/respond", { id, forward: true }, M2.t); ok(fw.s === 200 && fw.status === "forwarded", "forwarded " + fw.s);
  ok((await call("POST", "/api/intros/respond", { id, forward: true }, M2.t)).s === 404, "second forward refused");
  let off = await call("GET", "/api/intro-offers", null, T2.t); ok(off.offers.length === 1 && off.offers[0].from.name === "RqAlice" && off.offers[0].note === "Would love to meet", "target sees offer");
  const shown = JSON.stringify(off); ok(!/@in\.invalid|ownerToken|slug|phone|linkedin/i.test(shown), "offer exposes name, headline and note only");
  ok((await call("GET", "/api/intro-offers", null, A2.t)).offers.length === 0 && (await call("GET", "/api/intro-offers", null, Z.t)).offers.length === 0, "others see no offer");
  await sh(A2, false); ok((await call("GET", "/api/intro-offers", null, T2.t)).offers.length === 0, "requester opt-out hides the offer"); await sh(A2, true);
  ok((await call("GET", "/api/intro-offers", null, T2.t)).offers.length === 1, "offer returns with consent");
  await sh(T2, false); const ra = await call("POST", "/api/intro-offers/respond", { id, accept: true }, T2.t); ok(ra.s === 404, "target opted out cannot accept"); await sh(T2, true);
  ok((await call("GET", "/api/intro-offers", null, T2.t)).offers.length === 0, "withdrawn offer stays gone after a failed revalidation");
  ok(!(await ((await call("GET", "/api/people", null, A2.t)).people || []).find(p => p.card && p.card.name === "RqTara")), "nothing saved when revalidation failed");
}
{
  const A3 = await mk("RcAlice"), M3 = await mk("RcMia"), T3 = await mk("RcTara");
  await save(A3, M3); await save(M3, A3); await save(M3, T3); await save(T3, M3); for (const w of [A3, M3, T3]) await sh(w, true); await call("PUT", "/api/intro/consent", { on: true }, T3.t);
  await intro(A3, await idOf(A3, M3), T3); const id = (await call("GET", "/api/intros", null, M3.t)).intros[0].id;
  await call("POST", "/api/intros/respond", { id, forward: true }, M3.t);
  const m0 = sent.length; const [x, y] = await Promise.all([call("POST", "/api/intro-offers/respond", { id, accept: true }, T3.t), call("POST", "/api/intro-offers/respond", { id, accept: true }, T3.t)]);
  ok([x.s, y.s].filter(q => q === 200).length >= 1, "simultaneous accept on the KV fallback (not atomic): at least one wins " + x.s + "," + y.s);
  const pa = (await call("GET", "/api/people", null, A3.t)).people.filter(p => p.card.name === "RcTara"), pt = (await call("GET", "/api/people", null, T3.t)).people.filter(p => p.card.name === "RcAlice");
  ok(pa.length === 1 && pt.length === 1 && /Introduced by RcMia/.test(pa[0].event), "mutual saves marked as introduction, one each");
  ok(sent.length === m0, "no email at any step");
  const dI = await mk("RdAlice"), dM = await mk("RdMia"), dT = await mk("RdTara"); await save(dI, dM); await save(dM, dI); await save(dM, dT); await save(dT, dM); for (const w of [dI, dM, dT]) await sh(w, true); await call("PUT", "/api/intro/consent", { on: true }, dT.t);
  await intro(dI, await idOf(dI, dM), dT); const id2 = (await call("GET", "/api/intros", null, dM.t)).intros[0].id;
  ok((await call("POST", "/api/intros/respond", { id: id2, forward: false }, dM.t)).status === "declined", "via declines");
  ok((await call("GET", "/api/intro-offers", null, dT.t)).offers.length === 0, "declined intro never reaches target");
}

// ---- target re-consent (opt-in) and candidates ----
{
  const A4 = await mk("CnAlice"), M4 = await mk("CnMia"), T4 = await mk("CnTara");
  await save(A4, M4); await save(M4, A4); await save(M4, T4); await save(T4, M4); for (const w of [A4, M4, T4]) await sh(w, true);
  const v4 = await idOf(A4, M4);
  ok(JSON.stringify(await intro(A4, v4, T4)) === same, "no opt-in: same refusal as hidden");
  ok((await call("GET", "/api/intro/candidates", null, A4.t)).candidates.length === 0, "no opt-in: not a candidate");
  ok((await call("GET", "/api/intro/consent", null, T4.t)).on === false, "default is off");
  ok((await call("PUT", "/api/intro/consent", { on: "yes" }, T4.t)).s === 400, "consent needs a boolean");
  await cons(T4, true, false);
  let cd = (await call("GET", "/api/intro/candidates", null, A4.t)).candidates; ok(cd.length === 1 && cd[0].name === "CnTara" && cd[0].headline === undefined && cd[0].via.name === "CnMia" && !/slug|ownerToken|@/.test(JSON.stringify(cd)), "candidate: name only, no headline, no private fields");
  await cons(T4, true, true); cd = (await call("GET", "/api/intro/candidates", null, A4.t)).candidates; ok(cd[0].headline === "Engineer", "headline shown only with its own consent");
  const rq = await call("POST", "/api/intro", { viaPersonId: cd[0].via.personId, targetRef: cd[0].ref, note: "hi" }, A4.t); ok(rq.s === 200, "request by opaque ref " + rq.s);
  ok((await call("GET", "/api/intro/candidates", null, A4.t)).candidates[0].requested === true, "candidate marked requested");
  const il = (await call("GET", "/api/intros", null, M4.t)).intros; ok(il.length === 1 && il[0].target.headline === "Engineer", "middle sees headline when consented");
  await cons(T4, true, false); ok((await call("GET", "/api/intros", null, M4.t)).intros[0].target.headline === undefined, "headline consent withdrawn hides it at once");
  await cons(T4, false); ok((await call("GET", "/api/intros", null, M4.t)).intros.length === 0, "opt-out hides the request");
  ok((await call("POST", "/api/intro", { viaPersonId: cd[0].via.personId, targetRef: "f_0000000000000000" }, A4.t)).s === 404, "unknown ref refused");
}
console.log(`intro checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
