// One-shot storage move helper: copies a Workers KV namespace (SRC) into the Store Durable Object (STORE), page by page, inside Cloudflare.
// NOT part of the app worker and NOT routed on it. Deploy as its own temporary Worker bound to both stores. Every route answers 404 unless
// env.MIGRATE_TOKEN is set (a vault-held secret created for the move) and the request carries it. Delete the Worker after the move.
// Routes (POST, JSON): /copy {cursor} copies one page, /verify {cursor} compares one page, /count returns live row counts on the new side.
// Copy is idempotent (put with the absolute expiry; expired keys skipped), so a failed run is resumed from the last returned cursor.
export { Store } from "./store.js";
const PAGE = 50; // stays well under the Free limits of 50 subrequests and 10 ms CPU per request; raise only after measuring
const enc = new TextEncoder();
async function same(a, b) { const x = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(a)))), y = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(b)))); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }
export default {
  async fetch(req, env) {
    const nf = () => new Response("Not found", { status: 404 });
    if (!env.MIGRATE_TOKEN || req.method !== "POST") return nf();
    const h = req.headers.get("Authorization") || "";
    if (!(await same(h, "Bearer " + env.MIGRATE_TOKEN))) return nf();
    const stub = env.STORE.get(env.STORE.idFromName("main"));
    const store = async (ops) => (await (await stub.fetch("https://store/batch", { method: "POST", body: JSON.stringify({ ops }) })).json()).out;
    const p = new URL(req.url).pathname, body = await req.json().catch(() => ({}));
    if (p === "/count") return Response.json({ dst: (await store([{ o: "count" }]))[0] });
    if (p !== "/copy" && p !== "/verify") return nf();
    const page = await env.SRC.list({ cursor: body.cursor || undefined, limit: PAGE });
    const now = Date.now(), rows = [];
    for (const k of page.keys) {
      const exp = k.expiration ? k.expiration * 1000 : null;
      if (exp && exp <= now) continue;
      const v = await env.SRC.get(k.name);
      if (v !== null) rows.push({ k: k.name, v, exp });
    }
    const out = { n: rows.length, cursor: page.list_complete ? null : page.cursor, done: !!page.list_complete };
    if (p === "/copy") { const r = await store(rows.map(x => ({ o: "putabs", k: x.k, v: x.v, exp: x.exp }))); out.copied = r.filter(Boolean).length; }
    else { const r = await store(rows.map(x => ({ o: "get", k: x.k }))); out.mismatch = rows.filter((x, i) => r[i] !== x.v).map(x => x.k.split("/")[0] + "/..."); out.mismatches = out.mismatch.length; }
    return Response.json(out);
  },
};
