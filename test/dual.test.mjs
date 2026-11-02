// Dual-mode transition checks: every write lands in BOTH D1 and the mirrored KV namespace, and a failed mirror
// write still answers the user (D1 is truth) while surfacing the failure count on a header. Run: node test/dual.test.mjs
import assert from "node:assert/strict";
import worker, { RateLimiter } from "../worker/worker-d1.js";
import { FakeD1 } from "./serve-d1.mjs";
import { MemoryKV } from "./kv-shim.mjs";

const db = new FakeD1();
const mirror = new MemoryKV();
const objs = new Map();
const RL = { idFromName: n => n, get: id => ({ fetch: (u, init) => { if (!objs.has(id)) { const m = new Map(); objs.set(id, new RateLimiter({ storage: { get: async k => m.get(k), put: async (k, v) => { m.set(k, v); } } })); } return objs.get(id).fetch(new Request(u, init)); } }) };
const env = { DB: db, KV: mirror, STORE_MODE: "dual", GOOGLE_CLIENT_ID: "t", RL, DEBUG_STORE: "1" };
const BG = [];
async function call(m, p, b, t) { const h = { "content-type": "application/json" }; if (t) h.Authorization = "Bearer " + t; const r = await worker.fetch(new Request("http://x" + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined }), env, { waitUntil: p => BG.push(p) }); await Promise.all(BG.splice(0)); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; }

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("ok -", name); }

// Signup + card in dual mode: every key exists in both stores with identical values.
const a = await call("POST", "/api/auth/signup", { email: "dual@x.io", password: "password123", name: "Du" });
ok("signup works in dual mode", a.status === 200 && a.body.ownerToken);
const c = await call("POST", "/api/card", { ownerToken: a.body.ownerToken, card: { name: "Du", headline: "Maker", detail: "Builds", links: {} } });
ok("card created in dual mode", c.status === 200 && c.body.slug);
const kvOwn = await mirror.get("own/" + a.body.ownerToken);
const d1Own = (await db.prepare("SELECT v FROM kv WHERE k=?1").bind("own/" + a.body.ownerToken).first()).v;
ok("owner mapping identical in KV and D1", kvOwn === d1Own && kvOwn === c.body.slug);
const kvCard = await mirror.get("card/" + c.body.slug);
const d1Card = (await db.prepare("SELECT v FROM kv WHERE k=?1").bind("card/" + c.body.slug).first()).v;
ok("card identical in KV and D1", kvCard === d1Card);

// Mirror failure after D1 success: request still succeeds, failure is counted on a header, KV provably stale.
const op = mirror.put; mirror.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
const u = await call("POST", "/api/card", { ownerToken: a.body.ownerToken, card: { name: "Du", headline: "Updated", detail: "New detail", links: {} } });
mirror.put = op;
ok("mirror outage does not fail the user", u.status === 200);
ok("mirror failure is counted and logged, never silent", env.__store.mirrorFails > 0);
ok("KV is stale while D1 has the update (needs sync-back before rollback)", (await mirror.get("card/" + c.body.slug)).includes("Maker") && (await db.prepare("SELECT v FROM kv WHERE k=?1").bind("card/" + c.body.slug).first()).v.includes("Updated"));

// After the outage, dual writes resume keeping both stores in step.
const u2 = await call("POST", "/api/card", { ownerToken: a.body.ownerToken, card: { name: "Du", headline: "Final", detail: "Again", links: {} } });
ok("mirror recovers on the next write", u2.status === 200 && (await mirror.get("card/" + c.body.slug)).includes("Final"));

console.log(passed + " dual-mode checks passed");
