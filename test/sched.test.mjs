// Agent scheduling: calendar connect, free/busy-only sharing, propose/pick/confirm, booking writes, MCP calendar tools.
// Google endpoints are stubbed locally; the stub's freeBusy returns intervals only, exactly like Google's.
// Run: node test/sched.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
const { start } = await import("./serve.mjs");
const { srv, url, env } = await start(8803);
env.GOOGLE_CLIENT_SECRET = "test-secret";

// Stub Google: token refresh mints an access token keyed to the refresh token; freeBusy returns per-token
// busy intervals; events records writes. Any other path 404s (the worker must never list/read events).
const busyByToken = {}, eventCalls = [], eventDeletes = [], createdEvents = new Map(), failDeletes = new Set();
const detId = (id) => "t" + createHash("sha256").update(id).digest("hex").slice(0, 24);
const g = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/token") {
    if (raw.includes("grant_type=authorization_code")) {
      const code = (raw.match(/code=([^&]*)/) || [])[1];
      if (code === "badcode") { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      return res.end(JSON.stringify({ access_token: "at-rtO-" + code, refresh_token: "rtO-" + code, expires_in: 3600 }));
    }
    const rt = (raw.match(/refresh_token=([^&]*)/) || [])[1];
    if (rt === "bad") { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
    return res.end(JSON.stringify({ access_token: "at-" + rt, expires_in: 3600 }));
  }
  if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "oauth@example.com" }));
  const tok = decodeURIComponent((req.headers.authorization || "").replace("Bearer at-", ""));
  if (req.url === "/freebusy") return res.end(JSON.stringify({ calendars: { primary: { busy: busyByToken[tok] || [] } } }));
  if (req.url.startsWith("/events")) {
    const mid = req.url.match(/^\/events\/([^?]+)/);
    if (req.method === "DELETE") {
      const id = mid && decodeURIComponent(mid[1]);
      eventDeletes.push(req.url);
      if (id && failDeletes.has(id)) { res.writeHead(500); return res.end('{"error":"boom"}'); }
      if (id && createdEvents.has(id)) { createdEvents.delete(id); res.writeHead(204); return res.end(); }
      res.writeHead(404); return res.end('{"error":"not found"}'); // Google: deleting a missing event is a 404
    }
    if (req.method === "GET") {
      const id = mid && decodeURIComponent(mid[1]);
      const ev = id && createdEvents.get(id);
      if (ev) return res.end(JSON.stringify(ev));
      res.writeHead(404); return res.end('{"error":"not found"}');
    }
    const body = JSON.parse(raw);
    if (body.id && createdEvents.has(body.id)) { res.writeHead(409); return res.end('{"error":"duplicate"}'); } // Google: an existing event id rejects the create
    if (body.id) createdEvents.set(body.id, Object.assign({}, body));
    eventCalls.push({ tok, body });
    return res.end(JSON.stringify({ id: body.id || "ev" + eventCalls.length }));
  }
  res.writeHead(404); res.end("{}");
});
await new Promise(r => g.listen(8804, r));
env.GOOGLE_TOKEN_URL = "http://localhost:8804/token";
env.GOOGLE_FREEBUSY_URL = "http://localhost:8804/freebusy";
env.GOOGLE_EVENTS_URL = "http://localhost:8804/events";
env.GOOGLE_USERINFO_URL = "http://localhost:8804/userinfo";

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
await env.KV.put("tz/" + A.t, "UTC"); await env.KV.put("tz/" + B.t, "UTC");

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
ok("the proposal discloses that either person can cancel", prop.cancelableBy === "either");
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
ok("single-organizer confirm books one event on the proposer's calendar", conf.status === "booked" && conf.wrote.a === "booked" && conf.wrote.b === "no calendar connected" && eventCalls.length === 1);
ok("the event write matches the picked slot and title, with no attendee when the target has no calendar", eventCalls[0].body.summary === "Coffee" && eventCalls[0].body.start.dateTime === prop.slots[1] && !eventCalls[0].body.attendees);
ok("confirming again is idempotent - no second event", (await call("POST", "/api/sched/confirm", { id: prop.id }, A.t)).body.status === "booked" && eventCalls.length === 1);

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
ok("with both connected there is still exactly one event (no duplicate pair)", conf.status === "booked" && eventCalls.length === 2);
ok("the organizer's event invites the target's calendar email", conf.wrote.b === "invited via the event" && JSON.stringify(eventCalls[1].body.attendees || []) === JSON.stringify([{ email: "ben@example.com" }]));

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
ok("only the human confirm books it", conf.status === "booked" && eventCalls.length === before + 1);

// Cancel: either person can cancel; a booked event is deleted from the organizer's calendar; decline blocks cancel.
ok("a stranger cannot cancel", (await call("POST", "/api/sched/cancel", { id: p4.id }, X.t)).status === 404);
ok("a declined proposal cannot be cancelled", (await call("POST", "/api/sched/cancel", { id: p2.id }, B.t)).status === 409);
ok("the target can cancel a booked meeting", (await call("POST", "/api/sched/cancel", { id: p4.id }, B.t)).body.status === "cancelled" && eventDeletes.length === 1 && eventDeletes[0].includes("/events/" + detId(p4.id)));
ok("cancelling twice is idempotent", (await call("POST", "/api/sched/cancel", { id: p4.id }, A.t)).body.status === "cancelled" && eventDeletes.length === 1);
ok("a cancelled meeting cannot be confirmed", (await call("POST", "/api/sched/confirm", { id: p4.id }, A.t)).status === 409);

// Hardening: a lost create response must never duplicate the event - the retry's create hits 409 and adopts.
let p5 = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Retry", minutes: 30, from: T(14), to: T(16) }, A.t)).body;
await call("POST", "/api/sched/respond", { id: p5.id, pick: p5.slots[0] }, B.t);
createdEvents.set(detId(p5.id), { id: detId(p5.id), summary: "Retry", start: { dateTime: p5.slots[0] }, attendees: [{ email: "ben@example.com" }] }); // simulates Google's state after a first create whose response was lost in flight
const beforeRetry = eventCalls.length;
conf = (await call("POST", "/api/sched/confirm", { id: p5.id }, A.t)).body;
ok("a retry after a lost create response adopts the existing event instead of duplicating", conf.status === "booked" && eventCalls.length === beforeRetry);
ok("the adopted event keeps the deterministic id", conf.eventId === undefined && (await call("GET", "/api/sched", null, A.t)).body.schedule.some(x => x.id === p5.id && x.status === "booked"));

// A 409 for an event that does NOT match this request is never adopted.
let p5b = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Mismatch", minutes: 30, from: T(14), to: T(16) }, A.t)).body;
await call("POST", "/api/sched/respond", { id: p5b.id, pick: p5b.slots[0] }, B.t);
createdEvents.set(detId(p5b.id), { id: detId(p5b.id), summary: "Someone else's event", start: { dateTime: T(9) } });
const beforeMis = eventCalls.length;
const mis = (await call("POST", "/api/sched/confirm", { id: p5b.id }, A.t)).body;
ok("a 409 whose existing event does not match is not adopted", mis.status === "confirm-failed" && mis.wrote.a === "calendar write conflicted" && eventCalls.length === beforeMis);

// Hardening: two confirms racing the same proposal produce exactly one event.
let p6 = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Race", minutes: 30, from: T(14), to: T(16) }, A.t)).body;
await call("POST", "/api/sched/respond", { id: p6.id, pick: p6.slots[0] }, B.t);
const beforeRace = eventCalls.length;
const [rc1, rc2] = await Promise.all([call("POST", "/api/sched/confirm", { id: p6.id }, A.t), call("POST", "/api/sched/confirm", { id: p6.id }, A.t)]);
ok("concurrent confirms both settle on booked", rc1.body.status === "booked" && rc2.body.status === "booked");
ok("concurrent confirms write exactly one event", eventCalls.length === beforeRace + 1 && eventCalls[beforeRace].body.id === detId(p6.id));

// Hardening: disconnect warns about events left behind; cancelling afterwards cannot delete remotely and says so.
let p7 = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Later", minutes: 30, from: T(14), to: T(16) }, A.t)).body;
await call("POST", "/api/sched/respond", { id: p7.id, pick: p7.slots[0] }, B.t);
ok("a booking for the disconnect test", (await call("POST", "/api/sched/confirm", { id: p7.id }, A.t)).body.status === "booked");
const beforeDisc = eventDeletes.length;
const disc = (await call("DELETE", "/api/cal", null, A.t)).body;
ok("disconnect reports booked meetings left behind", disc.ok === true && disc.bookedLeft >= 1 && /can no longer/.test(disc.note || ""));
const canc = (await call("POST", "/api/sched/cancel", { id: p7.id }, B.t)).body;
ok("cancel after organizer disconnect is pending, never a false cancelled", canc.status === "cancel-pending" && /NOT cancelled/.test(canc.note || "") && eventDeletes.length === beforeDisc);
const rec7 = JSON.parse(await env.KV.get("sch/" + p7.id));
ok("pending cancel keeps the event id and the honest state in the record", rec7.status === "cancel-pending" && rec7.eventId === detId(p7.id) && /NOT cancelled/.test(rec7.cancelNote || ""));
await call("POST", "/api/cal/connect", { refreshToken: "rtA", email: "ann@example.com" }, A.t);
const canc2 = (await call("POST", "/api/sched/cancel", { id: p7.id }, B.t)).body;
ok("retrying the pending cancel after reconnect finishes it remotely", canc2.status === "cancelled" && eventDeletes.length === beforeDisc + 1);

// A failed remote delete is cancel-failed and retryable; a remote 404 still completes the cancel.
let p8 = (await call("POST", "/api/sched/propose", { slug: B.slug, title: "Fragile", minutes: 30, from: T(14), to: T(16) }, A.t)).body;
await call("POST", "/api/sched/respond", { id: p8.id, pick: p8.slots[0] }, B.t);
await call("POST", "/api/sched/confirm", { id: p8.id }, A.t);
failDeletes.add(detId(p8.id));
const cf1 = (await call("POST", "/api/sched/cancel", { id: p8.id }, A.t)).body;
ok("a failed remote delete is cancel-failed, not cancelled", cf1.status === "cancel-failed" && /NOT cancelled/.test(cf1.note || ""));
const rec8 = JSON.parse(await env.KV.get("sch/" + p8.id));
ok("cancel-failed keeps the live event id in the record", rec8.status === "cancel-failed" && rec8.eventId === detId(p8.id));
failDeletes.delete(detId(p8.id));
createdEvents.delete(detId(p8.id)); // the event is already gone on Google's side
ok("a remote 404 on retry completes the cancellation", (await call("POST", "/api/sched/cancel", { id: p8.id }, A.t)).body.status === "cancelled");

// Validation + cleanup.
ok("a window in the past is rejected", (await call("POST", "/api/sched/propose", { slug: B.slug, minutes: 30, from: T(-20), to: T(-18) }, A.t)).status === 400);
ok("minutes out of range is rejected", (await call("POST", "/api/sched/propose", { slug: B.slug, minutes: 5, from: T(14), to: T(16) }, A.t)).status === 400);
ok("proposing to someone not in your people is rejected", (await call("POST", "/api/sched/propose", { slug: X.slug, minutes: 30, from: T(14), to: T(16) }, A.t)).status === 400);
// Waking-hours slots: the whole meeting interval stays inside 08:00-20:00 in every known participant zone.
const minsIn = (iso, tz) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso)); return Number(p.find(x => x.type === "hour").value) * 60 + Number(p.find(x => x.type === "minute").value); };
{
  const r = (await call("POST", "/api/sched/propose", { slug: B.slug, minutes: 60, from: T(24), to: T(120), tz: "America/Phoenix" }, A.t));
  ok("propose with tz returns slots", r.status === 200 && r.body.slots.length > 0);
  ok("whole meeting stays 08:00-20:00 in every known zone", r.body.slots.every(x => ["America/Phoenix", "UTC"].every(z => { const m = minsIn(x, z); return m >= 480 && m + 60 <= 1200; })));
}
// A fresh pair with no stored timezone: a missing or unformattable zone is an explicit error, never a hidden default.
const W1 = await mk("Wia One"), W2 = await mk("Wia Two");
await call("POST", "/api/people", { slug: W2.slug, event: "Tz Conf" }, W1.t);
{
  const noTz = await call("POST", "/api/sched/propose", { slug: W2.slug, minutes: 30, from: T(24), to: T(120) }, W1.t);
  ok("propose without any known timezone is an explicit 400", noTz.status === 400 && /timezone/.test(noTz.body.error));
  const badTz = await call("POST", "/api/sched/propose", { slug: W2.slug, minutes: 30, from: T(24), to: T(120), tz: "America/Fakezone" }, W1.t);
  ok("a zone the runtime cannot format is rejected, not silently UTC", badTz.status === 400 && /timezone/.test(badTz.body.error));
  const good = await call("POST", "/api/sched/propose", { slug: W2.slug, minutes: 30, from: T(24), to: T(120), tz: "America/Phoenix" }, W1.t);
  ok("a real zone is accepted and stored", good.status === 200 && good.body.slots.length > 0);
  ok("summary exposes whose zones were used", good.body.tzA === "America/Phoenix" && good.body.tzB === null);
  const stored = await call("POST", "/api/sched/propose", { slug: W2.slug, minutes: 30, from: T(24), to: T(120) }, W1.t);
  ok("a stored zone is reused when tz is omitted", stored.status === 200 && stored.body.slots.every(x => { const m = minsIn(x, "America/Phoenix"); return m >= 480 && m + 30 <= 1200; }));
  ok("respond stores the picker's zone", (await call("POST", "/api/sched/respond", { id: good.body.id, pick: "decline", tz: "Asia/Tokyo" }, W2.t)).status === 200 && (await env.KV.get("tz/" + W2.t)) === "Asia/Tokyo");
  const both = await call("POST", "/api/sched/propose", { slug: W2.slug, minutes: 30, from: T(24), to: T(168) }, W1.t);
  ok("recipient zone filters once known", both.status === 200 && both.body.tzB === "Asia/Tokyo" && both.body.slots.every(x => ["America/Phoenix", "Asia/Tokyo"].every(z => { const m = minsIn(x, z); return m >= 480 && m + 30 <= 1200; })));
  // Both-party filtering: zones 12h apart have disjoint 08:00-20:00 windows, so there is nothing honest to offer.
  await env.KV.put("tz/" + W2.t, "Etc/GMT-12");
  const none = await call("POST", "/api/sched/propose", { slug: W2.slug, minutes: 30, from: T(24), to: T(168), tz: "UTC" }, W1.t);
  ok("disjoint waking hours produce an honest no-slots error", none.status === 400 && /waking hours/.test(none.body.error));
}

// Google OAuth connect routes (state one-time, honest 503 without server config, code exchange stores the calendar).
const O = await mk("Ora OAuth");
{
  const raw = (p) => fetch(url + p, { redirect: "manual", headers: { Authorization: "Bearer " + O.t } });
  ok("oauth start needs an app origin", ((await raw("/api/cal/google/start")).status) === 400);
  const st = await raw("/api/cal/google/start?app=http://localhost:8788");
  const startBody = await st.json();
  ok("oauth start returns a Google consent URL", st.status === 200 && /client_id=test-client/.test(startBody.url) && /redirect_uri=/.test(startBody.url) && /calendar.freebusy/.test(startBody.url) && /calendar.events/.test(startBody.url));
  const state = (startBody.url.match(/state=([^&]*)/) || [])[1];
  ok("oauth callback rejects an unknown state", (await fetch(url + "/api/cal/google/callback?code=x&state=nope", { redirect: "manual" })).status === 400);
  const denied = await fetch(url + "/api/cal/google/callback?error=access_denied&state=" + state, { redirect: "manual" });
  ok("oauth denial redirects back to the app with cal=denied", denied.status === 302 && (denied.headers.get("location") || "").startsWith("http://localhost:8788/#/schedule?cal=denied"));
  ok("oauth state is one-time", (await fetch(url + "/api/cal/google/callback?error=access_denied&state=" + state, { redirect: "manual" })).status === 400);
  // No client secret configured: honest 503, no fake success.
  const keep = env.GOOGLE_CLIENT_SECRET; delete env.GOOGLE_CLIENT_SECRET;
  const st2 = await (await raw("/api/cal/google/start?app=http://localhost:8788")).json();
  const state2 = (st2.url.match(/state=([^&]*)/) || [])[1];
  ok("oauth callback without server config is an honest 503", (await fetch(url + "/api/cal/google/callback?code=abc&state=" + state2, { redirect: "manual" })).status === 503);
  env.GOOGLE_CLIENT_SECRET = keep;
  const st3 = await (await raw("/api/cal/google/start?app=http://localhost:8788")).json();
  const state3 = (st3.url.match(/state=([^&]*)/) || [])[1];
  const done = await fetch(url + "/api/cal/google/callback?code=ok1&state=" + state3, { redirect: "manual" });
  ok("oauth callback stores the calendar and redirects connected", done.status === 302 && (done.headers.get("location") || "").startsWith("http://localhost:8788/#/schedule?cal=connected"));
  const stat = (await call("GET", "/api/cal/status", null, O.t)).body;
  ok("oauth-connected calendar shows email, sharing off", stat.connected === true && stat.email === "oauth@example.com" && stat.sharing === false);
  const st4 = await (await raw("/api/cal/google/start?app=http://localhost:8788")).json();
  const state4 = (st4.url.match(/state=([^&]*)/) || [])[1];
  ok("oauth callback with a bad code does not connect", (await fetch(url + "/api/cal/google/callback?code=badcode&state=" + state4, { redirect: "manual" })).status === 400);
}
ok("disconnect removes the calendar", (await call("DELETE", "/api/cal", null, B.t)).body.ok === true && (await call("GET", "/api/cal/status", null, B.t)).body.connected === false);
ok("account deletion removes scheduling records", (await call("DELETE", "/api/account", { confirm: "DELETE" }, A.t)).body.deleted === true && (await call("GET", "/api/sched", null, A.t)).status === 401);

srv.close(); g.close();
console.log(`\nAgent scheduling checks passed: ${passed}`);
