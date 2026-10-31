// Local synthetic volume run of the copy path (no Cloudflare, no KV writes).
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
const TOKEN = "t" + crypto.randomBytes(8).toString("hex"); const N = 5000;
const src = new FakeKV(); for (let i = 0; i < N; i++) src.m.set(`own/v${i}`, { v: JSON.stringify({ e: `v${i}@example.test`, pad: "x".repeat(300) }), exp: i % 8 === 0 ? Math.floor(Date.now() / 1000) + 9000 : null });
const dst = mkStore(); const env = { SRC: src, STORE: dst.ns, MIGRATE_TOKEN: TOKEN };
const run = (path, body) => mig.fetch(new Request("https://m" + path, { method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: JSON.stringify(body) }), env).then(r => r.json());
let cur = null, pages = 0, cpu0 = process.cpuUsage(), t0 = Date.now(), maxPage = 0;
for (;;) { const p0 = process.cpuUsage(); const r = await run("/copy", { cursor: cur }); const u = process.cpuUsage(p0); maxPage = Math.max(maxPage, (u.user + u.system) / 1000); pages++; cur = r.cursor; if (r.done) break; }
const u = process.cpuUsage(cpu0); console.log(`copy: ${N} keys, ${pages} pages, ${Date.now() - t0} ms wall, ${((u.user + u.system) / 1000 / pages).toFixed(2)} ms CPU per page avg, ${maxPage.toFixed(2)} ms max page (Node + SQLite, local, not workerd)`);
cur = null; let mm = 0; for (;;) { const r = await run("/verify", { cursor: cur }); mm += r.mismatches; cur = r.cursor; if (r.done) break; }
const cnt = (await run("/count", {})).dst; console.log(`verify mismatches ${mm}, count ${cnt}`); process.exit(mm === 0 && cnt === N ? 0 : 1);
