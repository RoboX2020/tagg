// Rollback reconciliation: copies current D1 rows back into KV. Use before rolling back to the KV entry if any
// mirror writes failed during the dual window (check x-mirror-failures / worker logs for "KV mirror write failed").
//
// Note: every restored key is a KV write, and KV Free allows 1,000 writes/day - for a large store, run in a quiet
// window or expect it to span more than one day. Current TAGG data is dozens of keys, so one run is enough.
//
// Usage (CLOUDFLARE_API_TOKEN in the environment):
//   node scripts/sync-d1-to-kv.mjs --account <acct-id> --namespace <kv-ns-id>
import { execSync } from "node:child_process";
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const ACCT = arg("--account"), NS = arg("--namespace");
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN || !ACCT || !NS) { console.error("need CLOUDFLARE_API_TOKEN, --account, --namespace"); process.exit(1); }

const out = execSync(`npx --yes wrangler@latest d1 execute tagg-store --json --command "SELECT k, v, exp FROM kv"`).toString();
const rows = JSON.parse(out)[0].results;
console.log("D1 rows to restore:", rows.length);
const now = Date.now();
let written = 0, skipped = 0;
for (const r of rows) {
  if (r.exp && r.exp <= now) { skipped++; continue; }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(r.k)}`, {
    method: "PUT",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "text/plain" },
    body: r.v,
  });
  const d = await res.json();
  if (!d.success) throw new Error("KV write failed for " + r.k + ": " + JSON.stringify(d.errors));
  written++;
}
console.log("restored", written, "keys to KV (skipped", skipped, "expired). Rollback to worker.js is now loss-free.");
