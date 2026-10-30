// Runs the real worker on http://localhost:8787 with in-memory storage, for local testing:  node test/serve.mjs
import http from "node:http";
import worker, { RateLimiter } from "../worker/worker.js";
import { MemoryKV } from "./kv-shim.mjs";
export function start(port = 8787) {
  // Stand-in for the Durable Object namespace: one RateLimiter instance per name, one request handled at a time.
  const objs = new Map();
  const RL = { idFromName: n => n, get: id => ({ fetch: (u, init) => {
    if (!objs.has(id)) { const m = new Map(); objs.set(id, { o: new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } } }), q: Promise.resolve() }); }
    const e = objs.get(id); const run = e.q.then(() => e.o.fetch(new Request(u, init))); e.q = run.catch(() => {}); return run; } }) };
  const env = { KV: new MemoryKV(), GOOGLE_CLIENT_ID: "test-client", ...(process.env.NO_DO ? {} : { RL }) };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
    const out = await worker.fetch(r, env, { waitUntil() {} });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise(ok => srv.listen(port, () => ok({ srv, env, url: "http://localhost:" + port })));
}
if (process.argv[1].endsWith("serve.mjs")) start().then(s => console.log("Tagg API on", s.url));
