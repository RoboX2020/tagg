// Branch-only entry (not deployed): same app, storage in Cloudflare D1 instead of Workers KV.
// STORE_MODE "dual" additionally mirrors every write to the original KV namespace, so rolling back to the
// KV entry (worker.js) loses nothing during the transition window. Default is D1-only.
import app, { RateLimiter } from "./worker.js";
import { D1KV } from "./store-d1.js";
export { RateLimiter };
export default {
  async fetch(req, env, ctx) {
    const kv = new D1KV(env.DB, { mirror: env.STORE_MODE === "dual" ? env.KV : null });
    if (env.DEBUG_STORE) env.__store = kv; // test hook: lets the harness inspect mirror failures after background work lands
    const bg = [];
    const ctx2 = { waitUntil: (p) => { const q = Promise.resolve(p).then(() => kv.flush()).catch(() => {}); bg.push(q); ctx.waitUntil(q); } };
    const res = await app.fetch(req, { ...env, KV: kv }, ctx2);
    try { await kv.flush(); }
    catch (e) { return new Response(JSON.stringify({ error: "Tagg is very busy right now. Please try again in a little while.", busy: true }), { status: 503, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }); }
    const out = new Response(res.body, res); out.headers.set("x-store-calls", String(kv.calls));
    if (kv.mirrorFails) out.headers.set("x-mirror-failures", String(kv.mirrorFails));
    return out;
  },
};
