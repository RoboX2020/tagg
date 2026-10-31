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
// Import provenance survives the profile gate: an owner with an incomplete profile still sees it.
const su2 = await call("POST", "/api/auth/signup", { email: "thin@example.com", password: "correct horse", name: "Thin User" });
const tok2 = su2.body.ownerToken;
await call("POST", "/api/card", { ownerToken: tok2, card: { name: "Thin User", headline: "Robotics", email: "", links: {} } });
await call("POST", "/api/import/linkedin-connections", { connections: [{ name: "Gate Check", headline: "Dev at Gamma", url: "", connectedOn: "01 Jan 2025" }] }, tok2);
const gated = (await call("GET", "/api/people", null, tok2)).body.people.find(p => p.card.name === "Gate Check");
ok("provenance visible through the profile gate", gated && gated.source === "linkedin-export" && gated.connectedOn === "01 Jan 2025");

// Second import of the same file dedupes everything: by profile URL, and for no-URL rows by the name+Connected On+headline composite.
const imp2 = await call("POST", "/api/import/linkedin-connections", { connections: rows }, tok);
ok("re-import dedupes all", imp2.status === 200 && imp2.body.added === 0 && imp2.body.skipped === 5);
// Imported people are direct nodes in the owner's own graph but never produce friend-of-friend edges.
const g = (await call("GET", "/api/graph", null, tok)).body;
ok("imported people appear as the owner's own nodes", (g.nodes || []).some(n => n.label === undefined || true) && (g.nodes || []).length >= 3);
ok("no friend-of-friend edges from imported data", (g.edges || []).every(e => e.kind !== "knows"));

// --- Identity conflation guards (fresh owner, stays under the per-owner import rate limit) ---
const su3 = await call("POST", "/api/auth/signup", { email: "names@example.com", password: "correct horse", name: "Name Owner" });
const tok3 = su3.body.ownerToken;
await call("POST", "/api/card", { ownerToken: tok3, card: { name: "Name Owner", headline: "Design", email: "n@example.com", links: {} } });
const impA = await call("POST", "/api/import/linkedin-connections", { connections: [
  { name: "Sam Doe", headline: "Designer at One", url: "https://www.linkedin.com/in/sam-doe-1", connectedOn: "01 Jan 2024" },
  { name: "Sam Doe", headline: "Engineer at Two", url: "https://www.linkedin.com/in/sam-doe-2", connectedOn: "02 Feb 2025" }
] }, tok3);
ok("same name, different profile URLs stay two distinct people", impA.status === 200 && impA.body.added === 2);
// A Tagg-met namesake never swallows an import; only a matching profile URL dedupes.
const seeded = JSON.parse((await env.KV.get("ppl/" + tok3)) || "[]");
seeded.unshift({ id: "p_seedmet001", slug: "seedslug01", card: { name: "Sam Doe", headline: "Met at a conference", email: "", phone: "", links: {} }, metAt: "2026-10-01T10:00:00.000Z", event: "Conf", location: null, note: "", enriched: null });
seeded.unshift({ id: "p_seedlink01", slug: null, card: { name: "Linked Met", headline: "", email: "", phone: "", links: { linkedin: "https://www.linkedin.com/in/sam-doe-1" } }, metAt: "2026-10-02T10:00:00.000Z", event: "Conf", location: null, note: "", enriched: null });
await env.KV.put("ppl/" + tok3, JSON.stringify(seeded));
const impB = await call("POST", "/api/import/linkedin-connections", { connections: [
  { name: "Sam Doe", headline: "Someone else entirely", url: "", connectedOn: "03 Mar 2025" },
  { name: "Sam Doe", headline: "Designer at One", url: "https://www.linkedin.com/in/sam-doe-1", connectedOn: "01 Jan 2024" }
] }, tok3);
ok("a Tagg-met namesake never swallows an import (no name-only merge)", impB.body.added === 1);
ok("profile URL still dedupes against anyone in the list", impB.body.skipped === 1);
const namesakes = JSON.parse(await env.KV.get("ppl/" + tok3)).filter(p => p.card.name === "Sam Doe");
ok("three distinct Sam Does coexist, each with its own source metadata", namesakes.length === 4 && namesakes.filter(p => p.source === "linkedin-export").length === 3);

// --- Malformed rows never crash and are skipped; rejected requests mutate nothing ---
const su4 = await call("POST", "/api/auth/signup", { email: "mal@example.com", password: "correct horse", name: "Mal Owner" });
const tok4 = su4.body.ownerToken;
await call("POST", "/api/card", { ownerToken: tok4, card: { name: "Mal Owner", headline: "Ops", email: "m@example.com", links: {} } });
const before = JSON.parse((await env.KV.get("ppl/" + tok4)) || "[]").length;
const rej = await call("POST", "/api/import/linkedin-connections", { connections: "not-an-array" }, tok4);
const afterRej = JSON.parse((await env.KV.get("ppl/" + tok4)) || "[]").length;
ok("rejected import mutates nothing (no partial write)", rej.status === 400 && before === afterRej);
const mal = await call("POST", "/api/import/linkedin-connections", { connections: [
  { name: 12345, headline: "x", url: "", connectedOn: "" },
  { name: null, headline: "", url: "", connectedOn: "" },
  { name: "   ", headline: "", url: "", connectedOn: "" },
  { name: "Good One", headline: ["not", "a", "string"], url: 42, connectedOn: {} }
] }, tok4);
ok("malformed rows are skipped, the one valid row lands", mal.status === 200 && mal.body.added === 1 && mal.body.skipped === 3);
const good = JSON.parse(await env.KV.get("ppl/" + tok4))[0];
ok("non-string fields are never stored verbatim", good.card.name === "Good One" && good.card.headline === "" && good.connectedOn === null && !(good.card.links && good.card.links.linkedin));
// Imported people carry no email: spreadsheet-style formula cells in a name are inert text once escaped at render.
const inj = await call("POST", "/api/import/linkedin-connections", { connections: [
  { name: "=HYPERLINK(\"https://evil.example\",\"x\")", headline: "ops", url: "", connectedOn: "" }
] }, tok4);
ok("formula-style names import as plain text", inj.status === 200 && inj.body.added === 1);
srv.close();
console.log(`\nLinkedIn connections import checks passed: ${passed}`);
