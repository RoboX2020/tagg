// Parity of profile-hints.js with the real server gate over all 32 combinations of the five card-derived sections (no photo, no LinkedIn).
// Plus photo/LinkedIn flags checked against the rule. Local server, synthetic data.
import assert from "node:assert/strict"; import fs from "node:fs"; import { start } from "./serve.mjs";
const m = { exports: {} }; new Function("module", "self", fs.readFileSync(new URL("../profile-hints.js", import.meta.url), "utf8"))(m, undefined); const { profileHints } = m.exports;
const api = await start(8811); api.env.SIGNUP_PER_HOUR = "500"; const U = "http://localhost:8811";
const call = async (m, p, b, t) => (await fetch(U + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined })).json();
let mism = 0, comp = 0;
for (let mask = 0; mask < 32; mask++) {
  const card = { name: "Syn Test", links: {} }; if (mask & 1) card.headline = "Maker"; if (mask & 2) card.detail = "Builds things"; if (mask & 4) card.links.github = "https://github.com/example"; if (mask & 8) card.email = "s@tagg-test.invalid"; if (mask & 16) card.phone = "+15550100";
  const a = await call("POST", "/api/auth/signup", { email: `h${mask}@tagg-test.invalid`, password: "pw-secret-123", name: "Syn Test" });
  await call("POST", "/api/card", { ownerToken: a.ownerToken, card }, a.ownerToken);
  const st = await call("GET", "/api/profile/status", null, a.ownerToken); const h = profileHints(card);
  if (st.complete !== h.complete) { mism++; console.log("MISMATCH", mask, st, h); } if (h.complete) comp++;
}
assert.equal(mism, 0); console.log("ok - 32/32 card combinations agree with the server gate;", comp, "complete");
assert.equal(profileHints({ name: "A", links: {} }, { hasPhoto: true, hasLinkedinDetails: true }).complete, true);
assert.equal(profileHints({ name: "A", links: {} }, { hasPhoto: true }).remaining, 1); assert.equal(profileHints(null).count, 0);
assert.equal(profileHints({ name: "A", headline: "ab", detail: "  ", links: { x: " " } }).count, 1);
console.log("ok - photo/LinkedIn flags, short strings and blanks follow the rule"); api.srv.close(); process.exit(0);
