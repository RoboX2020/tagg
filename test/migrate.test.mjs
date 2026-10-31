// Synthetic rehearsal of the KV -> Durable Object Store move with worker/migrate-worker.js. Synthetic data only, no network.
import { DatabaseSync } from "node:sqlite"; import crypto from "node:crypto";
import { Store } from "../worker/store.js"; import mig from "../worker/migrate-worker.js"; import { withFreeze } from "../worker/worker.js";
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
// Store DO stand-in
const mkStore = () => { const db = new DatabaseSync(":memory:"); const st = new Store({ storage: { sql: { exec: (q, ...a) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? s.all(...a) : (s.run(...a), []); } } } });
  const ns = { fail: false, calls: 0, idFromName: n => n, get: () => ({ fetch: async (u, init) => { ns.calls++; if (ns.fail && ns.calls > ns.failAfter) throw new Error("store unavailable"); return st.fetch(new Request(u, init)); } }) }; return { db, st, ns }; };
// KV stand-in with list(cursor, limit) + absolute expiration (seconds), write counting and a daily write budget
class FakeKV { constructor() { this.m = new Map(); this.writes = 0; this.budget = Infinity; }
  async get(k) { const r = this.m.get(k); return r && (!r.exp || r.exp * 1000 > Date.now()) ? r.v : null; }
  async put(k, v, o) { if (this.writes >= this.budget) throw new Error("KV put() limit exceeded for the day"); this.writes++; this.m.set(k, { v: String(v), exp: o && o.expirationTtl ? Math.floor(Date.now() / 1000) + o.expirationTtl : null }); }
  async delete(k) { if (this.writes >= this.budget) throw new Error("KV delete() limit exceeded for the day"); this.writes++; this.m.delete(k); }
  async list(o = {}) { const names = [...this.m.keys()].sort(); const start = o.cursor ? Number(o.cursor) : 0, lim = o.limit || 1000, slice = names.slice(start, start + lim);
    return { keys: slice.map(name => ({ name, expiration: this.m.get(name).exp || undefined })), list_complete: start + lim >= names.length, cursor: String(start + lim) }; } }
const TOKEN = crypto.randomBytes(16).toString("hex"); // random per run, never printed
const run = (env, path, body, tok = TOKEN) => mig.fetch(new Request("https://m" + path, { method: "POST", headers: tok ? { Authorization: "Bearer " + tok } : {}, body: JSON.stringify(body || {}) }), env);
const src = new FakeKV(); for (let i = 0; i < 230; i++) await src.put(`own/t${i}`, JSON.stringify({ e: `u${i}@example.test` }), i % 7 === 0 ? { expirationTtl: 3600 + i } : undefined);
await src.put("cfg/freeze", "off"); src.m.set("sess/old", { v: "x", exp: Math.floor(Date.now() / 1000) - 5 }); // already expired
const live = [...src.m.keys()].filter(k => k !== "sess/old").length;
// 1. auth: disabled / wrong token / wrong method all look like 404
{ const d = mkStore(); const e0 = { SRC: src, STORE: d.ns }; ok((await run(e0, "/copy", {})).status === 404, "no MIGRATE_TOKEN set: 404");
  const e1 = { ...e0, MIGRATE_TOKEN: TOKEN }; ok((await run(e1, "/copy", {}, "wrong")).status === 404 && (await run(e1, "/copy", {}, null)).status === 404, "wrong or missing token: 404");
  ok((await mig.fetch(new Request("https://m/copy"), e1)).status === 404, "GET: 404"); ok((await run(e1, "/other", {})).status === 404, "unknown route: 404"); }
// 2. failed partial import, then resume from the last good cursor
const dst = mkStore(); const env = { SRC: src, STORE: dst.ns, MIGRATE_TOKEN: TOKEN };
let cursor = null, copied = 0, lastGood = null, failed = false; dst.ns.failAfter = 3; dst.ns.fail = true; // store dies after 3 calls
for (let i = 0; i < 100; i++) { try { const r = await (await run(env, "/copy", { cursor })).json(); copied += r.copied; lastGood = r.cursor; cursor = r.cursor; if (r.done) break; } catch (e) { failed = true; break; } }
ok(failed, "partial import failed mid-way as injected"); const partial = (await dst.st.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops: [{ o: "count" }] }) })).then(r => r.json())).out[0];
ok(partial > 0 && partial < live, "partial copy is partial (" + partial + " of " + live + ")");
dst.ns.fail = false; for (let i = 0; i < 100; i++) { const r = await (await run(env, "/copy", { cursor })).json(); cursor = r.cursor; if (r.done) break; }
ok((await (await run(env, "/count", {})).json()).dst === live, "after resume the new side has exactly the live source rows (expired one skipped)");
// 3. verify every page
let c2 = null, mm = 0, seen = 0; for (let i = 0; i < 100; i++) { const r = await (await run(env, "/verify", { cursor: c2 })).json(); mm += r.mismatches; seen += r.n; c2 = r.cursor; if (r.done) break; }
ok(mm === 0 && seen === live, "verify: 0 mismatches over " + seen + " rows");
// absolute expiry preserved (not extended)
const e1 = src.m.get("own/t7").exp * 1000, e2 = dst.db.prepare("SELECT exp FROM kv WHERE k='own/t7'").all()[0].exp; ok(Math.abs(e1 - e2) < 1000, "expiry copied as absolute time");
// verify catches a divergence
dst.db.prepare("UPDATE kv SET v='tampered' WHERE k='own/t3'").run(); c2 = null; mm = 0; for (let i = 0; i < 100; i++) { const r = await (await run(env, "/verify", { cursor: c2 })).json(); mm += r.mismatches; c2 = r.cursor; if (r.done) break; }
ok(mm === 1, "verify detects a tampered row"); dst.db.prepare("UPDATE kv SET v=? WHERE k='own/t3'").run(await src.get("own/t3"));
// 4. drain proof: with the freeze on, two full snapshots of the source are identical even while writers keep trying
const snap = async () => { const h = crypto.createHash("sha256"); for (const k of [...src.m.keys()].sort()) h.update(k + "\0" + (await src.get(k)) + "\0" + (src.m.get(k).exp || "")); return h.digest("hex"); };
await src.put("cfg/freeze", "on"); const fenv = withFreeze({ KV: src, FREEZE_CACHE_MS: "0" }); const s1 = await snap(); let refused = 0;
for (const op of [() => fenv.KV.put("own/new", "x"), () => fenv.KV.delete("own/t1"), () => fenv.KV.put("scn/x", "1")]) { try { await op(); } catch (e) { if (e.frozen) refused++; } }
const s2 = await snap(); ok(refused === 3 && s1 === s2, "frozen: 3 writers refused, two snapshots identical"); await src.put("cfg/freeze", "off");
// 5. rollback replay with the KV daily write budget: changed keys on the new side must fit the remaining budget, else the replay stops, stays resumable, and the site stays frozen
const changed = []; for (let i = 0; i < 40; i++) { const k = i < 30 ? `own/post${i}` : `own/t${i}`; await dst.st.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops: [i % 10 === 9 ? { o: "del", k } : { o: "put", k, v: "after" + i }] }) })); changed.push(k); }
const dget = async k => (await dst.st.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops: [{ o: "get", k }] }) })).then(r => r.json())).out[0];
const rb = new FakeKV(); for (const [k, r] of src.m) rb.m.set(k, { ...r }); rb.budget = 25; let done = 0, exhausted = false;
const replay = async () => { for (const k of changed.slice(done)) { const v = await dget(k); if (v === null) await rb.delete(k); else await rb.put(k, v); done++; } };
try { await replay(); } catch (e) { exhausted = /limit exceeded/.test(e.message); }
ok(exhausted && done === 25, "rollback replay stopped at the write budget after " + done + " of " + changed.length + " keys");
rb.writes = 0; rb.budget = 1000; await replay(); // next day
let same2 = true; for (const k of changed) same2 = same2 && (await rb.get(k)) === (await dget(k)); ok(done === 40 && same2, "next day resume converges to the new side's state, deletes included");
console.log(`migrate rehearsal checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
