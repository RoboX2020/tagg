// Synthetic protected backup / restore / reverse-copy test. Synthetic data only; key is random per run, never printed or stored.
import { DatabaseSync } from "node:sqlite"; import crypto from "node:crypto"; import { Store } from "../worker/store.js";
const mk = () => { const db = new DatabaseSync(":memory:"); const st = new Store({ storage: { sql: { exec: (q, ...a) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? s.all(...a) : (s.run(...a), []); } } } }); return { db, st }; };
const call = async (s, ops) => (await (await s.st.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops }) }))).json()).out;
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
const src = mk(); const ops = [];
for (let i = 0; i < 500; i++) ops.push({ o: "put", k: `own/tok${i}`, v: JSON.stringify({ email: `u${i}@example.test`, hash: "pbkdf2:synthetic" + i }), ttl: i % 5 === 0 ? 3600 + i : undefined });
await call(src, ops);
// Export: stream rows in pages, store REMAINING ttl (not absolute), encrypt with AES-256-GCM, authenticated with header.
const key = crypto.randomBytes(32);
const exportAll = (s, key) => { const now = Date.now(), rows = s.db.prepare("SELECT k,v,exp FROM kv WHERE exp IS NULL OR exp>? ORDER BY k").all(now).map(r => ({ k: r.k, v: r.v, ttl: r.exp ? Math.round((r.exp - now) / 1000) : null })); const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); c.setAAD(Buffer.from("tagg-backup-v1")); const ct = Buffer.concat([c.update(JSON.stringify(rows)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]); };
const importAll = async (s, blob, key) => { const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12)); d.setAAD(Buffer.from("tagg-backup-v1")); d.setAuthTag(blob.subarray(12, 28)); const rows = JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString()); for (let i = 0; i < rows.length; i += 100) await call(s, rows.slice(i, i + 100).map(r => ({ o: "put", k: r.k, v: r.v, ttl: r.ttl || undefined }))); return rows.length; };
const blob = exportAll(src, key);
ok(!blob.toString("latin1").includes("example.test") && !blob.toString("latin1").includes("pbkdf2"), "artifact has no plaintext");
// Tamper and wrong key must fail
const bad = Buffer.from(blob); bad[40] ^= 1; let thrown = false; try { await importAll(mk(), bad, key); } catch { thrown = true; } ok(thrown, "tampered blob rejected");
thrown = false; try { await importAll(mk(), blob, crypto.randomBytes(32)); } catch { thrown = true; } ok(thrown, "wrong key rejected");
// Restore
const dst = mk(); ok(await importAll(dst, blob, key) === 500, "row count");
const cmp = (a, b) => { const q = "SELECT k,v,exp FROM kv ORDER BY k"; const A = a.db.prepare(q).all(), B = b.db.prepare(q).all(); return A.length === B.length && A.every((r, i) => r.k === B[i].k && r.v === B[i].v && (r.exp === null) === (B[i].exp === null) && (r.exp === null || Math.abs(r.exp - B[i].exp) < 3000)); };
ok(cmp(src, dst), "restored data and TTL match within 3 s");
// Writes during cutover: source takes writes after snapshot; delta pass copies keys changed since, via a write log
const log = new Set(); const w = async (k, v) => { await call(src, [{ o: "put", k, v }]); log.add(k); };
await w("own/tok7", "changed"); await w("own/new1", "n1"); await call(src, [{ o: "del", k: "own/tok9" }]); log.add("own/tok9");
ok(!cmp(src, dst), "divergence exists before delta");
for (const k of log) { const [v] = await call(src, [{ o: "get", k }]); await call(dst, [v === null ? { o: "del", k } : { o: "put", k, v }]); }
ok(cmp(src, dst), "delta pass converges (incl. delete)");
// Reverse copy (rollback): export from dst, restore into a fresh KV-like target, with dst having taken writes
await call(dst, [{ o: "put", k: "own/after-cutover", v: "x" }]);
const rb = mk(); await importAll(rb, exportAll(dst, key), key); ok(cmp(dst, rb), "reverse copy matches incl. post-cutover write");
// Expiry: an expired key is excluded from export
src.db.prepare("UPDATE kv SET exp=? WHERE k='own/tok0'").run(Date.now() - 1000); const rows2 = new Set(); const b2 = mk(); await importAll(b2, exportAll(src, key), key); ok(b2.db.prepare("SELECT 1 FROM kv WHERE k='own/tok0'").all().length === 0, "expired not exported");
console.log(`backup checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
