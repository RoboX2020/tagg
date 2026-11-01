// Agent scheduling: calendar connect, free/busy-only sharing, propose/pick/confirm, booking writes, MCP calendar tools.
// Google endpoints are stubbed locally; the stub's freeBusy returns intervals only, exactly like Google's.
// Run: node test/sched.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
const { start } = await import("./serve.mjs");
const { srv, url, env } = await start(8803);
env.GOOGLE_CLIENT_SECRET = "test-secret";

// Stub Google: token refresh mints an access token keyed to the refresh token; freeBusy returns per-token
// busy intervals; events records writes. Any other path 404s (the worker must never list/read events).
const busyByToken = {}, eventCalls = [];
const g = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/token") {
    const rt = (raw.match(/refresh_token=([^&]*)/) || [])[1];
    if (rt === "bad") { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
    return res.end(JSON.stringify({ access_token: "at-" + rt, expires_in: 3600 }));
  }
  const tok = decodeURIComponent((req.headers.authorization || "").replace("Bearer at-", ""));
  if (req.url === "/freebusy") return res.end(JSON.stringify({ calendars: { primary: { busy: busyByToken[tok] || [] } } }));
  if (req.url === "/events") { eventCalls.push({ tok, body: JSON.parse(raw) }); return res.end(JSON.stringify({ id: "ev" + eventCalls.length })); }
  res.writeHead(404); res.end("{}");
});
await new Promise(r => g.listen(8804, r));
env.GOOGLE_TOKEN_URL = "http://localhost:8804/token";
env.GOOGLE_FREEBUSY_URL = "http://localhost:8804/freebusy";
env.GOOGLE_EVENTS_URL = "http://localhost:8804/events";

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("ok -", name); }
async function call(method, path, body, tok) {
  const r = await fetch(url + path, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const mk = async (name) => { const t = (await call("POST", "/api/owner", {})).body.ownerToken;
  const slug = (await call("POST", "/api/card", { ownerToken: t, card: { name, headline: "Sched test", detail: "test detail" } })).body.slug; return { t, slug }; };

// Two people who met: A saved B as a person.
const A = await mk("Ann Sched"), B = await mk("Ben Sched");
await call("POST", "/api/people", { slug: B.slug, event: "Test Conf" }, A.t);

// Calendar status starts disconnected; sharing/freebusy need a connection first.
ok("status: disconnected by default", (await call("GET", "/api/cal/status", null, A.t)).body.connected === false);
ok("sharing requires a connected calendar", (await call("PUT", "/api/cal/sharing", { on: true }, A.t)).status === 400);
ok("freebusy requires a connected calendar", (await call("GET", "/api/cal/freebusy", null, A.t)).status === 400);
ok("a token Google rejects is not stored", (await call("POST", "/api/cal/connect", { refreshToken: "bad" }, A.t)).status === 400);

// Connect A. Sharing stays off until A turns it on.
ok("connect stores the calendar, sharing off", (await call("POST", "/api/cal/connect", { refreshToken: "rtA", email: "ann@example.com" }, A.t)).body.sharing === false);
let st = (await call("GET", "/api/cal/status", null, A.t)).body;
ok("status: connected with email, sharing off", st.connected === true && st.email === "ann@example.com" && st.sharing === false);

// A's busy block: 15:00-16:00 UTC tomorrow. free/busy returns intervals only - no titles, no details.
const day = new Date(Date.now() + 86400000); day.setUTCHours(0, 0, 0, 0);
const T = (h) => new Date(day.getTime() + h * 3600000).toISOString();
busyByToken["rtA"] = [{ start: T(15), end: T(16) }];
const fb = (await call("GET", "/api/cal/freebusy?from=" + encodeURIComponent(T(8)) + "&to=" + encodeURIComponent(T(20)), null, A.t)).body;
ok("freebusy returns the busy interval", fb.busy.length === 1 && fb.busy[0].start === T(15) && fb.busy[0].end === T(16));
ok("freebusy carries no event details", !JSON.stringify(fb).match(/summary|title|description|attendee/i));

// Propose: B has no calendar, so slots avoid only A's busy. Both see the proposal; nothing is sent or booked.
let prop = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Coffee", minutes: 60, from: T(14), to: T(19) }, A.t)).body;
ok("proposal recorded with slots that avoid A's busy", prop.status === "proposed" && prop.slots.length > 0 && !prop.slots.includes(T(15)) && !prop.slots.includes(T(15.5)));
ok("proposer sees it as outgoing", (await call("GET", "/api/sched", null, A.t)).body.schedule.some(x => x.id === prop.id && x.role === "out"));
ok("target sees it as incoming with the proposer's name", (await call("GET", "/api/sched", null, B.t)).body.schedule.some(x => x.id === prop.id && x.role === "in" && x.withName === "Ann Sched"));

// Wrong actors: A cannot respond to their own proposal; a stranger cannot respond.
ok("proposer cannot pick a slot", (await call("POST", "/api/sched/respond", { id: prop.id, pick: prop.slots[0] }, A.t)).status === 404);
const X = await mk("Xena Stranger");
ok("a stranger cannot respond", (await call("POST", "/api/sched/respond", { id: prop.id, pick: prop.slots[0] }, X.t)).status === 404);
ok("a slot outside the proposal is rejected", (await call("POST", "/api/sched/respond", { id: prop.id, pick: T(3) }, B.t)).status === 400);

// B picks, A confirms. B has no calendar: A's event is written, the pair is "confirmed" (manual for B).
ok("target picks a slot", (await call("POST", "/api/sched/respond", { id: prop.id, pick: prop.slots[1] }, B.t)).body.status === "picked");
let conf = (await call("POST", "/api/sched/confirm", { id: prop.id }, A.t)).body;
ok("confirm books A's calendar and confirms the time", conf.status === "confirmed" && conf.wrote.a === "booked" && conf.wrote.b === "no calendar connected");
ok("the event write matches the picked slot and title", eventCalls.length === 1 && eventCalls[0].body.summary === "Coffee" && eventCalls[0].body.start.dateTime === prop.slots[1]);

// Decline flow.
let p2 = (await call("POST", "/api/sched/propose", { slug: B.slug, minutes: 30, from: T(14), to: T(16) }, A.t)).body;
ok("target can decline", (await call("POST", "/api/sched/respond", { id: p2.id, pick: "decline" }, B.t)).body.status === "declined");
ok("a declined proposal cannot be picked", (await call("POST", "/api/sched/respond", { id: p2.id, pick: p2.slots[0] }, B.t)).status === 409);

// Both connected, B sharing on: slots avoid BOTH busies; confirm writes BOTH calendars with an invite.
await call("POST", "/api/cal/connect", { refreshToken: "rtB", email: "ben@example.com" }, B.t);
busyByToken["rtB"] = [{ start: T(17), end: T(18) }];
let p3 = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Sync", minutes: 60, from: T(14), to: T(20) }, A.t)).body;
ok("without B sharing, only A's busy shapes slots", p3.slots.includes(T(17)));
await call("PUT", "/api/cal/sharing", { on: true }, B.t);
p3 = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Sync", minutes: 60, from: T(14), to: T(20) }, A.t)).body;
ok("with B sharing, slots avoid both calendars' busy", !p3.slots.includes(T(15)) && !p3.slots.includes(T(16.5)) && !p3.slots.includes(T(17)));
await call("POST", "/api/sched/respond", { id: p3.id, pick: p3.slots[0] }, B.t);
conf = (await call("POST", "/api/sched/confirm", { id: p3.id }, A.t)).body;
ok("confirm with both connected books both calendars", conf.status === "booked" && conf.wrote.a === "booked" && conf.wrote.b === "booked");
ok("B's event invites A's calendar email", eventCalls.length === 3 && JSON.stringify(eventCalls[2].body.attendees || []) === JSON.stringify([{ email: "ann@example.com" }]));

// MCP: a calendar-scope grant gets the scheduling tools; a people-only grant does not.
const tokCal = (await call("POST", "/api/tokens", { name: "Ann agent", scope: "people+cal" }, A.t)).body.token;
const tokPeople = (await call("POST", "/api/tokens", { name: "Ann reader", scope: "people" }, A.t)).body.token;
const mcp = (tk, method, params) => fetch(url + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(r => r.json());
const callTool = async (tk, name, args) => { const r = await mcp(tk, "tools/call", { name, arguments: args || {} }); return JSON.parse(r.result.content[0].text); };
const tools = (await mcp(tokCal, "tools/list", {})).result.tools.map(t => t.name);
ok("agent sees the scheduling tools", ["check_availability", "list_schedule", "propose_meeting", "respond_meeting"].every(t => tools.includes(t)));
ok("check_availability returns the busy interval", (await callTool(tokCal, "check_availability", { from: T(8), to: T(20) })).busy.length === 1);
ok("list_schedule shows the booked meeting", (await callTool(tokCal, "list_schedule")).schedule.some(x => x.id === p3.id && x.status === "booked"));
const denied = await callTool(tokPeople, "propose_meeting", { slug: B.slug, minutes: 30, from: T(14), to: T(16) });
ok("a people-only grant cannot use calendar tools", !!denied.error);

// Agent-to-agent: A's agent proposes; B's agent (B's own grant) picks; A (the human) confirms in the app.
const p4 = await callTool(tokCal, "propose_meeting", { slug: B.slug, title: "Agent meet", minutes: 30, from: T(14), to: T(18) });
ok("agent proposal recorded for both users", p4.status === "proposed" && (await call("GET", "/api/sched", null, B.t)).body.schedule.some(x => x.id === p4.id));
const tokB = (await call("POST", "/api/tokens", { name: "Ben agent", scope: "cal" }, B.t)).body.token;
ok("B's agent picks a slot", (await callTool(tokB, "respond_meeting", { id: p4.id, pick: p4.slots[0] })).status === "picked");
const before = eventCalls.length;
conf = (await call("POST", "/api/sched/confirm", { id: p4.id }, A.t)).body;
ok("only the human confirm books it", conf.status === "booked" && eventCalls.length === before + 2);

// Validation + cleanup.
ok("a window in the past is rejected", (await call("POST", "/api/sched/propose", { slug: B.slug, minutes: 30, from: T(-20), to: T(-18) }, A.t)).status === 400);
ok("minutes out of range is rejected", (await call("POST", "/api/sched/propose", { slug: B.slug, minutes: 5, from: T(14), to: T(16) }, A.t)).status === 400);
ok("proposing to someone not in your people is rejected", (await call("POST", "/api/sched/propose", { slug: X.slug, minutes: 30, from: T(14), to: T(16) }, A.t)).status === 400);
ok("disconnect removes the calendar", (await call("DELETE", "/api/cal", null, B.t)).body.ok === true && (await call("GET", "/api/cal/status", null, B.t)).body.connected === false);
ok("account deletion removes scheduling records", (await call("DELETE", "/api/account", { confirm: "DELETE" }, A.t)).body.deleted === true && (await call("GET", "/api/sched", null, A.t)).status === 401);

srv.close(); g.close();
console.log(`\nAgent scheduling checks passed: ${passed}`);
