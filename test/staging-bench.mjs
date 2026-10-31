// Measures real latency and consistency on a STAGING worker with synthetic data only. Usage: node test/staging-bench.mjs https://tagg-staging...workers.dev
const U = process.argv[2]; const lat = {}; const calls = {};
async function call(m, p, b, t) {
  const t0 = performance.now();
  const r = await fetch(U + p, { method: m, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({})); const k = m + " " + p.replace(/[a-z0-9]{8,}/g, ":id");
  (lat[k] ||= []).push(performance.now() - t0); (calls[k] ||= []).push(Number(r.headers.get("x-store-calls") || 0));
  return { s: r.status, ...j };
}
const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
async function user(i, tag) {
  const s = await call("POST", "/api/auth/signup", { email: `bench${tag}${i}@example.invalid`, password: "bench-password-" + i, name: "Bench " + i });
  const c = await call("POST", "/api/card", { ownerToken: s.ownerToken, card: { name: "Bench " + i, headline: "Synthetic", detail: "Load test user", email: `bench${tag}${i}@example.invalid`, links: {} } }, s.ownerToken);
  await call("POST", "/api/graph/sharing", null, s.ownerToken);
  await call("PUT", "/api/graph/sharing", { on: true }, s.ownerToken);
  return { t: s.ownerToken, slug: c.slug, s: s.s, cs: c.s };
}
const tag = Date.now().toString(36);
const N = 12, us = [];
for (let i = 0; i < 4; i++) us.push(await user(i, tag));            // sequential
us.push(...await Promise.all(Array.from({ length: N - 4 }, (_, i) => user(i + 4, tag)))); // concurrent
console.log("signup/card statuses ok:", us.every(u => u.s === 200 && u.cs === 200 && u.slug));
// connect + accept chain: user[i] requests user[0]
const conc = await Promise.all(us.slice(1).map(u => call("POST", "/api/connect", { slug: us[0].slug, requesterToken: u.t, event: "bench" })));
console.log("concurrent connects to one card:", conc.map(c => c.s).join(","));
const ib = await call("GET", "/api/inbox", null, us[0].t); console.log("inbox shows", (ib.requests || []).length, "of", us.length - 1);
for (const r of (ib.requests || []).slice(0, 6)) await call("POST", "/api/inbox/respond", { id: r.id, accept: true }, us[0].t);
const people = await call("GET", "/api/people", null, us[0].t); console.log("people after accepts:", (people.people || []).length);
// concurrent writes to one key: 10 saves of the same card
await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/api/card", { ownerToken: us[1].t, card: { name: "Bench 1", headline: "Edit " + i, detail: "x", links: {} } }, us[1].t)));
for (let i = 0; i < 5; i++) { await call("GET", "/api/graph", null, us[0].t); await call("GET", "/api/c/" + us[0].slug); await call("POST", "/api/scan", { slug: us[0].slug }); }
console.log("\nrequest".padEnd(34), "n   p50ms p95ms  DOcalls(avg)");
for (const k of Object.keys(lat)) console.log(k.padEnd(34), String(lat[k].length).padStart(3), String(Math.round(pct(lat[k], .5))).padStart(6), String(Math.round(pct(lat[k], .95))).padStart(6), (calls[k].reduce((a, b) => a + b, 0) / calls[k].length).toFixed(1).padStart(8));
