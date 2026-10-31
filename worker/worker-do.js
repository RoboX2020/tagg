// PROTOTYPE entry (not deployed): same app, but storage is the SQLite Durable Object through a per-request batching client.
import app, { RateLimiter } from "./worker.js";
import { Store, BatchedKV } from "./store.js";
export { RateLimiter, Store };
export default {
  async fetch(req, env, ctx) {
    const kv = new BatchedKV(env.STORE);
    const bg = [];
    const ctx2 = { waitUntil: (p) => { const q = Promise.resolve(p).then(() => kv.flush()).catch(() => {}); bg.push(q); ctx.waitUntil(q); } };
    const res = await app.fetch(req, { ...env, KV: kv }, ctx2);
    try { await kv.flush(); }
    catch (e) { return new Response(JSON.stringify({ error: "Tagg is very busy right now. Please try again in a little while.", busy: true }), { status: 503, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
    const out = new Response(res.body, res); out.headers.set("x-store-calls", String(kv.calls));
    return out;
  },
};
