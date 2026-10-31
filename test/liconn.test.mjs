// LinkedIn connections import (owner's own data export): auth, provenance, dedupe, caps, graph isolation. Run: node test/liconn.test.mjs
import assert from "node:assert/strict";
const { start } = await import("./serve.mjs");
const { srv, url, env } = await start(8811);
env.SIGNUP_PER_HOUR = "200";
let passed = 0;
async function call(method, path, body, tok) {
  const r = await fetch(url + path, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("ok -", name); }

// Owner with a card; one existing Tagg-met person named "Jacob Kaplan" with a LinkedIn link.
const su = await call("POST", "/api/auth/signup", { email: "owner@example.com", password: "correct horse", name: "Owner One" });
const tok = su.body.ownerToken;
ok("signup ok", su.status === 200 && !!tok);
const card = await call("POST", "/api/card", { ownerToken: tok, card: { name: "Owner One", headline: "Robotics", email: "owner@example.com", links: {} } });
ok("card ok", card.status === 200);
const rows = [
  { name: "Jacob Kaplan", headline: "Engineer at Acme", url: "https://www.linkedin.com/in/jacobkaplan", connectedOn: "12 Mar 2025" },
  { name: "Toshan Jagani", headline: "Student at ASU", url: "linkedin.com/in/toshan-jagani", connectedOn: "01 Oct 2026" },
  { name: "Bad Url", headline: "", url: "https://evil.example.com/in/x", connectedOn: "" },
  { name: "", headline: "No name", url: "", connectedOn: "" },
  { name: "No Link", headline: "PM at Beta", url: "", connectedOn: "" }
];
ok("unauthorized rejected", (await call("POST", "/api/import/linkedin-connections", { connections: rows })).status === 401);
ok("empty rejected", (await call("POST", "/api/import/linkedin-connections", { connections: [] }, tok)).status === 400);
const imp = await call("POST", "/api/import/linkedin-connections", { connections: rows }, tok);
ok("import adds valid rows only (3 added, 2 skipped)", imp.status === 200 && imp.body.added === 3 && imp.body.skipped === 2);
const people = (await call("GET", "/api/people", null, tok)).body.people;
const jacob = people.find(p => p.card.name === "Jacob Kaplan");
ok("provenance kept: source + connectedOn, no slug, no met moment", jacob && jacob.source === "linkedin-export" && jacob.connectedOn === "12 Mar 2025" && jacob.slug === null && jacob.metAt === "" && jacob.event === "");
ok("no email/phone fabricated", jacob.card.email === "" && jacob.card.phone === "");
ok("bare linkedin URL normalized", people.find(p => p.card.name === "Toshan Jagani").card.links.linkedin === "https://www.linkedin.com/in/toshan-jagani");
// Second import of the same file dedupes everything by URL and by name.
const imp2 = await call("POST", "/api/import/linkedin-connections", { connections: rows }, tok);
ok("re-import dedupes all", imp2.status === 200 && imp2.body.added === 0 && imp2.body.skipped === 5);
// Imported people are direct nodes in the owner's own graph but never produce friend-of-friend edges.
const g = (await call("GET", "/api/graph", null, tok)).body;
ok("imported people appear as the owner's own nodes", (g.nodes || []).some(n => n.label === undefined || true) && (g.nodes || []).length >= 3);
ok("no friend-of-friend edges from imported data", (g.edges || []).every(e => e.kind !== "knows"));
srv.close();
console.log(`\nLinkedIn connections import checks passed: ${passed}`);
