// Bounded concurrency and idempotency checks on a STAGING worker (synthetic data). Usage: node test/staging-load.mjs URL [users]
const U = process.argv[2], N = Number(process.argv[3] || 40); const lat = [];
async function call(m, p, b, t) { const t0 = performance.now(); const r = await fetch(U + p, { method: m, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const j = await r.json().catch(() => ({})); lat.push(performance.now() - t0); return { s: r.status, ...j }; }
const tag = Date.now().toString(36);
const mk = async (i) => { const s = await call("POST", "/api/auth/signup", { email: `load${tag}${i}@example.invalid`, password: "load-password-" + i, name: "Load " + i }); const c = await call("POST", "/api/card", { ownerToken: s.ownerToken, card: { name: "Load " + i, headline: "Synthetic", detail: "d", links: {} } }, s.ownerToken); return { t: s.ownerToken, slug: c.slug, ok: s.s === 200 && c.s === 200 }; };
const t0 = performance.now(); const us = await Promise.all(Array.from({ length: N }, (_, i) => mk(i)));
console.log(`${N} concurrent signups+cards: ${us.filter(u => u.ok).length} ok in ${Math.round(performance.now() - t0)} ms`);
const owner = us[0];
const cs = await Promise.all(us.slice(1).map(u => call("POST", "/api/connect", { slug: owner.slug, requesterToken: u.t, event: "load" })));
console.log("concurrent connects:", cs.filter(c => c.s === 200).length, "of", N - 1, "| duplicates:", cs.filter(c => c.duplicate).length);
const ib = await call("GET", "/api/inbox", null, owner.t); console.log("owner inbox has", (ib.requests || []).length, "pending of", N - 1);
// every request accepted at once, and the first one accepted twice at the same moment
const reqs = ib.requests || [];
const acc = await Promise.all([...reqs.map(r => call("POST", "/api/inbox/respond", { id: r.id, accept: true }, owner.t)), call("POST", "/api/inbox/respond", { id: reqs[0].id, accept: true }, owner.t)]);
console.log("accept results: ok", acc.filter(a => a.s === 200).length, "| already-handled", acc.filter(a => a.s === 400).length, "| other", acc.filter(a => a.s !== 200 && a.s !== 400).length);
const ppl = (await call("GET", "/api/people", null, owner.t)).people || []; const slugs = ppl.map(p => p.slug).filter(Boolean);
console.log("owner saved people:", ppl.length, "of", reqs.length, "| duplicate slugs:", slugs.length - new Set(slugs).size);
const after = (await call("GET", "/api/inbox", null, owner.t)).requests || []; console.log("requests still pending after accepts:", after.filter(r => r.status === "pending").length);
let back = 0; for (const u of us.slice(1, 11)) { const p = (await call("GET", "/api/people", null, u.t)).people || []; if (p.some(x => x.card && x.card.name === "Load 0")) back++; } console.log("sampled requesters who got the owner saved back:", back, "of 10");
const sorted = lat.sort((a, b) => a - b); console.log("latency over", sorted.length, "calls: p50", Math.round(sorted[Math.floor(sorted.length * .5)]), "ms, p95", Math.round(sorted[Math.floor(sorted.length * .95)]), "ms, max", Math.round(sorted[sorted.length - 1]), "ms");
