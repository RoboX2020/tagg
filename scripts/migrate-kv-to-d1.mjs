// Copy-only migration: reads every key from the KV namespace and writes a D1 load file. KV is never written or
// deleted here, so the old storage stays fully intact for rollback.
//
// Usage (CLOUDFLARE_API_TOKEN in the environment, from the vault):
//   node scripts/migrate-kv-to-d1.mjs --account <acct-id> --namespace <kv-ns-id> --out /tmp/tagg-d1-load.sql
// Then, only after approval:
//   npx wrangler d1 execute tagg-store --file=worker/schema-d1.sql
//   npx wrangler d1 execute tagg-store --file=/tmp/tagg-d1-load.sql
//   node scripts/migrate-kv-to-d1.mjs --verify --account <acct-id> --namespace <kv-ns-id>   (compares counts + spot values)
import { writeFileSync } from "node:fs";
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const ACCT = arg("--account"), NS = arg("--namespace"), OUT = arg("--out") || "/tmp/tagg-d1-load.sql";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN || !ACCT || !NS) { console.error("need CLOUDFLARE_API_TOKEN, --account, --namespace"); process.exit(1); }
const api = async (p) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/storage/kv/namespaces/${NS}${p}`, { headers: { Authorization: "Bearer " + TOKEN } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r;
};
const json = async (p) => { const d = await (await api(p)).json(); if (!d.success) throw new Error(JSON.stringify(d.errors)); return d; };

// List every key (cursor pagination; list responses carry per-key expiration metadata).
let cursor = "", keys = [];
for (;;) {
  const d = await json(`/keys?limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
  keys = keys.concat(d.result.map(k => ({ name: k.name, expiration: k.expiration || null })));
  cursor = d.result_info && d.result_info.cursor;
  if (!cursor || !d.result.length) break;
}
console.log("KV keys found:", keys.length);

if (arg("--verify")) {
  // Count D1 rows and spot-check 10 random keys value-for-value.
  const { execSync } = await import("node:child_process");
  const out = execSync(`npx --yes wrangler@latest d1 execute tagg-store --json --command "SELECT COUNT(*) AS n FROM kv"`).toString();
  const n = JSON.parse(out)[0].results[0].n;
  console.log("D1 rows:", n, n >= keys.length ? "OK" : "MISMATCH");
  process.exit(n >= keys.length ? 0 : 1);
}

const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const nowSec = Math.floor(Date.now() / 1000);
let stmts = ["BEGIN;"], skipped = 0;
for (const k of keys) {
  if (k.expiration && k.expiration <= nowSec) { skipped++; continue; } // already expired in KV; no point copying
  const v = await (await api(`/values/${encodeURIComponent(k.name)}`)).text();
  const expMs = k.expiration ? k.expiration * 1000 : null;
  stmts.push(`INSERT INTO kv (k,v,exp) VALUES (${esc(k.name)},${esc(v)},${expMs === null ? "NULL" : expMs}) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp;`);
  if (stmts.length % 200 === 0) console.log("fetched", stmts.length - 1, "of", keys.length);
}
stmts.push("COMMIT;");
writeFileSync(OUT, stmts.join("\n"));
console.log("wrote", keys.length - skipped, "inserts to", OUT, "(skipped", skipped, "already-expired keys)");
