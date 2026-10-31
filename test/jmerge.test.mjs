import { DatabaseSync } from "node:sqlite"; import { Store } from "../worker/store.js";
const db = new DatabaseSync(":memory:"); const st = new Store({ storage: { sql: { exec: (q, ...a) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? s.all(...a) : (s.run(...a), []); } } } });
const call = async ops => (await (await st.fetch(new Request("http://x", { method: "POST", body: JSON.stringify({ ops }) }))).json()).out;
await call([{ o: "put", k: "enrich/a", v: JSON.stringify({ linkedin: { t: 1 }, github: { u: "x" } }), ttl: 100 }]);
await Promise.all([call([{ o: "jmerge", k: "enrich/a", set: { linkedin: { t: 2 } } }]), call([{ o: "jmerge", k: "enrich/a", set: { x: { y: 1 } }, del: ["github"] }])]);
const [v] = await call([{ o: "get", k: "enrich/a" }]); const o = JSON.parse(v), e = db.prepare("SELECT exp FROM kv").get().exp;
const ok = o.linkedin.t === 2 && o.x.y === 1 && !o.github && e; console.log(ok ? "jmerge checks passed" : "FAIL " + v); process.exit(ok ? 0 : 1);
