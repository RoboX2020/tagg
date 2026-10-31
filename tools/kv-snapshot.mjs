#!/usr/bin/env node
// Operator tool: encrypted point-in-time snapshot of a Workers KV namespace through the Cloudflare REST API, and its verification.
//   node tools/kv-snapshot.mjs snapshot --account A --namespace N --token-file PATH --key-file PATH --out FILE [--api URL]
//   node tools/kv-snapshot.mjs verify   --in FILE --key-file PATH
//   node tools/kv-snapshot.mjs digest   --in FILE            (count and hash from the plaintext header, no key needed)
// --token-file and --key-file are PATHS to files that hold the API token and the backup passphrase (for example the vault-backed files under
// /home/sandbox/.vault/<entry>/). Secrets are read from the files, never taken from the command line, never printed, never written to the output.
// The AES-256-GCM key comes from scrypt(passphrase, random salt). The header (magic, salt, iv, count, digest) is authenticated, the rows are encrypted.
// Read-only against KV (list and bulk get). It writes nothing to Cloudflare.
import fs from "node:fs"; import crypto from "node:crypto";
const MAGIC = "TAGGBK2\n";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const readSecret = (p) => { const v = fs.readFileSync(p, "utf8").split("\n")[0].trim(); if (!v) throw new Error("empty secret file: " + p); return v; };
export const digestRows = (rows) => { const h = crypto.createHash("sha256"); for (const r of [...rows].sort((a, b) => a.k < b.k ? -1 : 1)) h.update(r.k + "\0" + r.v + "\0" + (r.exp || "") + "\n"); return h.digest("hex"); };
async function cf(api, token, path, init = {}) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(api + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 500 * (a + 1))); continue; }
    const j = await r.json().catch(() => null); if (!r.ok || !j || j.success === false) throw new Error("Cloudflare API " + r.status + " on " + path.split("?")[0]); return j;
  }
  throw new Error("Cloudflare API kept failing on " + path.split("?")[0]);
}
export async function readNamespace({ api, account, namespace, token }) {
  const base = `/accounts/${account}/storage/kv/namespaces/${namespace}`, names = []; let cursor = "";
  for (;;) { const j = await cf(api, token, `${base}/keys?limit=1000${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`); for (const k of j.result) names.push({ k: k.name, exp: k.expiration || null }); cursor = j.result_info && j.result_info.cursor; if (!cursor) break; }
  const rows = [], now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100).filter(x => !x.exp || x.exp > now);
    const j = await cf(api, token, `${base}/bulk/get`, { method: "POST", body: JSON.stringify({ keys: chunk.map(x => x.k) }) });
    const vals = j.result && j.result.values ? j.result.values : j.result;
    for (const x of chunk) { const v = vals[x.k]; if (v !== null && v !== undefined) rows.push({ k: x.k, v: typeof v === "string" ? v : JSON.stringify(v), exp: x.exp }); }
  }
  return rows;
}
export function seal(rows, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const meta = JSON.stringify({ v: 2, at: new Date().toISOString(), count: rows.length, digest: digestRows(rows), salt: salt.toString("hex"), iv: iv.toString("hex") });
  const c = crypto.createCipheriv("aes-256-gcm", key, iv); c.setAAD(Buffer.from(meta)); const ct = Buffer.concat([c.update(JSON.stringify(rows)), c.final()]);
  const head = Buffer.from(meta); const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
  return Buffer.concat([Buffer.from(MAGIC), len, head, c.getAuthTag(), ct]);
}
export function header(buf) { if (buf.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error("not a Tagg snapshot"); const n = buf.readUInt32BE(MAGIC.length), at = MAGIC.length + 4; return { meta: JSON.parse(buf.subarray(at, at + n).toString()), raw: buf.subarray(at, at + n), rest: buf.subarray(at + n) }; }
export function open(buf, passphrase) {
  const { meta, raw, rest } = header(buf), key = crypto.scryptSync(passphrase, Buffer.from(meta.salt, "hex"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(meta.iv, "hex")); d.setAAD(raw); d.setAuthTag(rest.subarray(0, 16));
  const rows = JSON.parse(Buffer.concat([d.update(rest.subarray(16)), d.final()]).toString());
  if (rows.length !== meta.count || digestRows(rows) !== meta.digest) throw new Error("snapshot content does not match its header");
  return { meta, rows };
}
if (process.argv[1] && process.argv[1].endsWith("kv-snapshot.mjs")) {
  const cmd = process.argv[2];
  try {
    if (cmd === "snapshot") {
      const rows = await readNamespace({ api: arg("api", "https://api.cloudflare.com/client/v4"), account: arg("account"), namespace: arg("namespace"), token: readSecret(arg("token-file")) });
      const buf = seal(rows, readSecret(arg("key-file"))); fs.writeFileSync(arg("out"), buf, { mode: 0o600 });
      const { meta } = header(buf); console.log(JSON.stringify({ out: arg("out"), count: meta.count, digest: meta.digest, at: meta.at }));
    } else if (cmd === "verify") { const { meta } = open(fs.readFileSync(arg("in")), readSecret(arg("key-file"))); console.log(JSON.stringify({ ok: true, count: meta.count, digest: meta.digest, at: meta.at })); }
    else if (cmd === "digest") { const { meta } = header(fs.readFileSync(arg("in"))); console.log(JSON.stringify({ count: meta.count, digest: meta.digest, at: meta.at })); }
    else { console.error("usage: snapshot | verify | digest (see file header)"); process.exit(2); }
  } catch (e) { console.error("error: " + e.message); process.exit(1); }
}
