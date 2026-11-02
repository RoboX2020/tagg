// Runs the D1 storage entry (worker-d1.js) locally, with node:sqlite standing in for D1. Used by: TAGG_D1=1 node test/api.test.mjs
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import worker, { RateLimiter } from "../worker/worker-d1.js";
import { D1KV } from "../worker/store-d1.js";
export const stats = { queries: 0, rowsRead: 0, rowsWritten: 0, byPath: new Map() };

// Minimal stand-in for the D1 API (prepare/bind/all/first/run + transactional batch) over an in-memory SQLite db.
class FakeStmt {
  constructor(fake, q) { this.fake = fake; this.q = q; this.p = []; }
  bind(...p) { this.p = p.map(v => v === undefined ? null : v); return this; }
  _all() { stats.queries++; const rows = this.fake.db.prepare(this.q).all(...this.p); stats.rowsRead += rows.length; return { results: rows }; }
  _first() { stats.queries++; const rows = this.fake.db.prepare(this.q).all(...this.p); stats.rowsRead += rows.length; return rows[0] ?? null; }
  _run() { stats.queries++; const info = this.fake.db.prepare(this.q).run(...this.p); stats.rowsWritten += Number(info.changes); return { meta: { changes: Number(info.changes) } }; }
  all() { return this.fake._serialize(() => this._all()); }
  first() { return this.fake._serialize(() => this._first()); }
  run() { return this.fake._serialize(() => this._run()); }
}
class FakeD1 {
  constructor() { this.db = new DatabaseSync(":memory:"); this.db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)"); this._q = Promise.resolve(); }
  // Real D1 serializes access per database (single writer); the shim serializes too, so batches never nest.
  _serialize(f) { const r = this._q.then(f); this._q = r.catch(() => {}); return r; }
  prepare(q) { return new FakeStmt(this, q); }
  batch(stmts) {
    return this._serialize(async () => {
      this.db.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(/^\s*select/i.test(s.q) ? await s._all() : await s._run());
        this.db.exec("COMMIT");
        return out;
      } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    });
  }
}

export function start(port = 8788) {
  const fake = new FakeD1();
  const objs = new Map();
  const RL = { idFromName: n => n, get: id => ({ fetch: (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, { o: new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } } }), q: Promise.resolve() }); } const e = objs.get(id); const run = e.q.then(() => e.o.fetch(new Request(u, init))); e.q = run.catch(() => {}); return run; } }) };
  // Test-side direct access to the same data (the API tests poke storage keys directly).
  const direct = async (f) => { const kv = new D1KV(fake); const r = await f(kv); await kv.flush(); return r; };
  const testKV = { get: k => direct(kv => kv.get(k)), put: (k, v, o) => direct(kv => kv.put(k, v, o)), delete: k => direct(kv => kv.delete(k)), list: o => direct(kv => kv.list(o)) };
  const env = { DB: fake, KV: testKV, GOOGLE_CLIENT_ID: "test-client", RL };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const pending = []; const before = stats.queries;
    const out = await worker.fetch(r, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    const pth = new URL(r.url).pathname.replace(/[a-z0-9]{8,}/g, ":id"); const e = stats.byPath.get(pth) || { n: 0, max: 0, sum: 0 }; const c = stats.queries - before; e.n++; e.sum += c; e.max = Math.max(e.max, c); stats.byPath.set(pth, e);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise(ok => srv.listen(port, () => ok({ srv, env, url: "http://localhost:" + port })));
}
