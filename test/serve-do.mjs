// Runs the prototype Durable Object storage entry (worker-do.js) locally, with node:sqlite standing in for the DO's SQLite. Used by: TAGG_DO=1 node test/api.test.mjs
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import worker, { RateLimiter, Store } from "../worker/worker-do.js";
import { BatchedKV } from "../worker/store.js";
export const stats = { calls: 0, byPath: new Map() };
export function start(port = 8788) {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(q, ...p) { const st = db.prepare(q); return /^\s*select/i.test(q) ? st.all(...p) : (st.run(...p), []); } };
  const store = new Store({ storage: { sql } });
  const ns = { idFromName: n => n, get: () => ({ fetch: async (u, init) => { stats.calls++; return store.fetch(new Request(u, init)); } }) };
  const objs = new Map();
  const RL = { idFromName: n => n, get: id => ({ fetch: (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, { o: new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } } }), q: Promise.resolve() }); } const e = objs.get(id); const run = e.q.then(() => e.o.fetch(new Request(u, init))); e.q = run.catch(() => {}); return run; } }) };
  // Test-side direct access to the same data (the API tests poke KV keys directly).
  const direct = async (f) => { const kv = new BatchedKV(ns); const r = await f(kv); await kv.flush(); return r; };
  const testKV = { get: k => direct(kv => kv.get(k)), put: (k, v, o) => direct(kv => kv.put(k, v, o)), delete: k => direct(kv => kv.delete(k)), list: o => direct(kv => kv.list(o)) };
  const env = { KV: testKV, STORE: ns, GOOGLE_CLIENT_ID: "test-client", RL };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const pending = []; const before = stats.calls;
    const out = await worker.fetch(r, env, { waitUntil: p => pending.push(p) });
    await Promise.all(pending);
    const pth = new URL(r.url).pathname.replace(/[a-z0-9]{8,}/g, ":id"); const e = stats.byPath.get(pth) || { n: 0, max: 0, sum: 0 }; const c = stats.calls - before; e.n++; e.sum += c; e.max = Math.max(e.max, c); stats.byPath.set(pth, e);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise(ok => srv.listen(port, () => ok({ srv, env, url: "http://localhost:" + port })));
}
