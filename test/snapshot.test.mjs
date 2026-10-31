// Tests tools/kv-snapshot.mjs against a LOCAL mock of the Cloudflare KV REST API. Synthetic data only, no network, no live export.
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto"; import { execFile } from "node:child_process";
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++, console.log("FAIL", m)); };
const data = new Map(); const now = Math.floor(Date.now() / 1000);
for (let i = 0; i < 250; i++) data.set(`own/s${i}`, { v: JSON.stringify({ e: `s${i}@example.test`, h: "pbkdf2:synthetic" }), exp: i % 9 === 0 ? now + 5000 + i : null });
data.set("sess/expired", { v: "x", exp: now - 10 }); let writes = 0, reads = 0, flaky = 1;
const TOKEN = "t_" + crypto.randomBytes(12).toString("hex"), PASS = crypto.randomBytes(24).toString("base64");
const srv = http.createServer(async (q, s) => {
  let body = ""; for await (const c of q) body += c; const u = new URL(q.url, "http://x"); const send = (o, st = 200) => { s.writeHead(st, { "content-type": "application/json" }); s.end(JSON.stringify(o)); };
  if (q.headers.authorization !== "Bearer " + TOKEN) return send({ success: false }, 403);
  if (q.method !== "GET" && !u.pathname.endsWith("/bulk/get")) writes++;
  if (u.pathname.endsWith("/keys")) { if (flaky-- > 0) return send({ success: false }, 503); const names = [...data.keys()].sort(), start = Number(u.searchParams.get("cursor") || 0), lim = Number(u.searchParams.get("limit")), sl = names.slice(start, start + lim);
    return send({ success: true, result: sl.map(name => ({ name, ...(data.get(name).exp ? { expiration: data.get(name).exp } : {}) })), result_info: { cursor: start + lim < names.length ? String(start + lim) : "" } }); }
  if (u.pathname.endsWith("/bulk/get")) { reads++; const { keys } = JSON.parse(body); if (keys.length > 100) return send({ success: false }, 400); const values = {}; for (const k of keys) values[k] = data.has(k) ? data.get(k).v : null; return send({ success: true, result: { values } }); }
  send({ success: false }, 404);
}).listen(0); await new Promise(r => srv.once("listening", r)); const api = `http://localhost:${srv.address().port}/client/v4`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-")); const tf = path.join(dir, "token"), kf = path.join(dir, "key"); fs.writeFileSync(tf, TOKEN + "\n"); fs.writeFileSync(kf, PASS + "\n");
// async spawn: the mock server runs in this process, so a blocking spawn would deadlock it
const run = (...a) => new Promise(res => execFile("node", ["tools/kv-snapshot.mjs", ...a], { encoding: "utf8" }, (e, stdout, stderr) => res({ status: e ? (e.code || 1) : 0, stdout, stderr })));
const out = path.join(dir, "a.snap"); let r = (await run("snapshot", "--api", api, "--account", "acc", "--namespace", "ns", "--token-file", tf, "--key-file", kf, "--out", out));
ok(r.status === 0, "snapshot ran (including a retried 503): " + r.stderr); const live = [...data.keys()].filter(k => k !== "sess/expired").length; const info = JSON.parse(r.stdout);
ok(info.count === live, "count equals live keys, expired skipped (" + info.count + ")"); ok(!r.stdout.includes(TOKEN) && !r.stdout.includes(PASS) && !r.stderr.includes(TOKEN) && !r.stderr.includes(PASS), "no secret in output");
const bin = fs.readFileSync(out); ok(!bin.toString("latin1").includes("example.test") && !bin.toString("latin1").includes("pbkdf2") && !bin.includes(Buffer.from(TOKEN)) && !bin.includes(Buffer.from(PASS)), "file has no plaintext data and no secrets");
ok((fs.statSync(out).mode & 0o077) === 0, "output file is owner-only"); ok(writes === 0, "read-only against the source (0 writes)"); ok(reads === 3, "bulk reads in chunks of 100 (" + reads + " calls for " + live + " keys)");
r = (await run("verify", "--in", out, "--key-file", kf)); ok(r.status === 0 && JSON.parse(r.stdout).digest === info.digest, "verify with the right key passes");
const wk = path.join(dir, "wrong"); fs.writeFileSync(wk, "not the key\n"); ok((await run("verify", "--in", out, "--key-file", wk)).status === 1, "wrong key rejected");
const bad = Buffer.from(bin); bad[bad.length - 40] ^= 1; fs.writeFileSync(path.join(dir, "bad.snap"), bad); ok((await run("verify", "--in", path.join(dir, "bad.snap"), "--key-file", kf)).status === 1, "tampered ciphertext rejected");
const bh = Buffer.from(bin); bh[20] ^= 1; fs.writeFileSync(path.join(dir, "bh.snap"), bh); ok((await run("verify", "--in", path.join(dir, "bh.snap"), "--key-file", kf)).status === 1, "tampered header rejected");
// two snapshots of an unchanged source have equal digests; a changed source differs
const out2 = path.join(dir, "b.snap"); (await run("snapshot", "--api", api, "--account", "acc", "--namespace", "ns", "--token-file", tf, "--key-file", kf, "--out", out2));
const d1 = JSON.parse((await run("digest", "--in", out)).stdout), d2 = JSON.parse((await run("digest", "--in", out2)).stdout); ok(d1.digest === d2.digest && d1.count === d2.count, "unchanged source: equal digests (readable without the key)");
data.get("own/s5").v = "changed"; const out3 = path.join(dir, "c.snap"); (await run("snapshot", "--api", api, "--account", "acc", "--namespace", "ns", "--token-file", tf, "--key-file", kf, "--out", out3)); ok(JSON.parse((await run("digest", "--in", out3)).stdout).digest !== d1.digest, "changed source: digest differs");
ok((await run("snapshot", "--api", api, "--account", "acc", "--namespace", "ns", "--token-file", path.join(dir, "missing"), "--key-file", kf, "--out", path.join(dir, "z"))).status === 1, "missing token file fails cleanly");
fs.rmSync(dir, { recursive: true }); srv.close(); console.log(`snapshot tool checks: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
