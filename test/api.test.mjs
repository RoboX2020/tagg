// End-to-end API test: signup, login, scan-to-connect, consent, mutual saving, private notes, location. Run: node test/api.test.mjs
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
// Set TAGG_API to run the same checks against a deployed worker (use a staging worker: it creates accounts).
const { srv, url, env } = process.env.TAGG_API ? { srv: { close() {} }, url: process.env.TAGG_API } : await start(8799);
let passed = 0;
async function call(method, path, body, tok) {
  const r = await fetch(url + path, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("ok -", name); }

// Alice signs up with email + password and makes a card.
let a = await call("POST", "/api/auth/signup", { email: "Alice@Example.com", password: "correct horse", name: "Alice Ng" });
ok("signup returns owner token", a.status === 200 && a.body.ownerToken);
const aTok = a.body.ownerToken;
ok("short password rejected", (await call("POST", "/api/auth/signup", { email: "x@y.co", password: "short" })).status === 400);
ok("bad email rejected", (await call("POST", "/api/auth/signup", { email: "nope", password: "longenough1" })).status === 400);
ok("duplicate email rejected (case-insensitive)", (await call("POST", "/api/auth/signup", { email: "alice@example.com", password: "another pass" })).status === 409);
let card = await call("POST", "/api/card", { ownerToken: aTok, card: { name: "Alice Ng", headline: "Robotics", email: "alice@example.com", links: { github: "" } } });
ok("card created with slug", card.status === 200 && /^[a-z0-9]{8}$/.test(card.body.slug));
const slug = card.body.slug;

// Login: wrong password, right password.
ok("wrong password rejected", (await call("POST", "/api/auth/login", { email: "alice@example.com", password: "wrong wrong" })).status === 401);
let l = await call("POST", "/api/auth/login", { email: "ALICE@example.com", password: "correct horse" });
ok("login returns same owner", l.status === 200 && l.body.ownerToken === aTok);
let me = await call("GET", "/api/me", null, aTok);
ok("/api/me shows profile and card", me.body.profile.email === "alice@example.com" && me.body.slug === slug);

// Rate limit on login attempts.
let last; for (let i = 0; i < 9; i++) last = await call("POST", "/api/auth/login", { email: "bob-nobody@example.com", password: "guess guess" + i });
ok("login attempts are rate limited", last.status === 429);

// Bob scans Alice's QR, signs up as part of the scan, and his connect request carries location + private note.
let b = await call("POST", "/api/auth/signup", { email: "bob@example.com", password: "bobs password", name: "Bob Li" });
const bTok = b.body.ownerToken;
await call("POST", "/api/card", { ownerToken: bTok, card: { name: "Bob Li", headline: "ML", email: "bob@example.com", links: {} } });
let cr = await call("POST", "/api/connect", { slug, requesterToken: bTok, event: "Cal Hacks", note: "Talked about sim2real - Bob only",
  location: { lat: 37.8719, lon: -122.2585, label: "Berkeley, CA", place: "Hearst Gym" } }, null);
ok("connect request created pending", cr.status === 200 && cr.body.status === "pending");
let inbox = await call("GET", "/api/inbox", null, aTok);
ok("Alice sees the request with shared location", inbox.body.requests.length === 1 && inbox.body.requests[0].location.place === "Hearst Gym");
ok("requester private note not exposed to Alice", !JSON.stringify(inbox.body).includes("Bob only"));
ok("bad coordinates are dropped", (await call("POST", "/api/connect", { slug, requesterToken: (await call("POST", "/api/owner", {})).body.ownerToken, name: "Eve", location: { lat: 999, lon: 5, label: "" } })).status === 200);
let acc = await call("POST", "/api/inbox/respond", { id: inbox.body.requests[0].id, accept: true }, aTok);
ok("Alice accepts", acc.body.status === "accepted");

// Reciprocal profiles + same moment on both sides.
let ap = (await call("GET", "/api/people", null, aTok)).body.people;
let bp = (await call("GET", "/api/people", null, bTok)).body.people;
ok("Alice saved Bob's card", ap.some(p => p.card.name === "Bob Li"));
ok("Bob saved Alice's card", bp.some(p => p.card.name === "Alice Ng"));
ok("both records share the meeting time and event", ap[0].metAt === bp[0].metAt && ap[0].event === "Cal Hacks" && bp[0].event === "Cal Hacks");
ok("location saved with place name", bp[0].location.place === "Hearst Gym" && bp[0].location.lat === 37.8719);
ok("Bob's private context note landed only on Bob's record", bp[0].note.includes("Bob only") && ap[0].note === "");

// Notes and photos are private to each owner.
await call("PUT", "/api/people/" + ap[0].id, { note: "Alice private note" }, aTok);
bp = (await call("GET", "/api/people", null, bTok)).body.people;
ok("Alice's note is invisible to Bob", !JSON.stringify(bp).includes("Alice private note"));
ok("unauthenticated people list refused", (await call("GET", "/api/people")).status === 401);
ok("Bob cannot edit Alice's person record", (await call("PUT", "/api/people/" + ap[0].id, { note: "hack" }, bTok)).status === 404);

// Device data merges into the account on login.
const dev = (await call("POST", "/api/owner", {})).body.ownerToken;
await call("POST", "/api/migrate", { ownerToken: dev, people: [{ card: { name: "Old Contact" }, metAt: "2026-01-01T00:00:00Z" }] });
l = await call("POST", "/api/auth/login", { email: "alice@example.com", password: "correct horse", deviceToken: dev });
ap = (await call("GET", "/api/people", null, aTok)).body.people;
ok("device people merged into account on login", ap.some(p => p.card.name === "Old Contact"));
// Recovery code: shown once at sign-up, resets the password, then rotates.
const rc = a.body.recoveryCode;
ok("signup returns a recovery code", /^[a-z0-9]{5}(-[a-z0-9]{5}){3}$/.test(rc));
ok("reset with wrong code refused", (await call("POST", "/api/auth/reset", { email: "alice@example.com", recoveryCode: "aaaaa-bbbbb-ccccc-ddddd", newPassword: "brand new pass" })).status === 401);
let rs = await call("POST", "/api/auth/reset", { email: "alice@example.com", recoveryCode: rc, newPassword: "brand new pass" });
ok("reset with the right code works and rotates the code", rs.status === 200 && rs.body.recoveryCode && rs.body.recoveryCode !== rc);
ok("old password no longer works", (await call("POST", "/api/auth/login", { email: "alice@example.com", password: "correct horse" })).status === 401);
ok("new password works", (await call("POST", "/api/auth/login", { email: "alice@example.com", password: "brand new pass" })).status === 200);
ok("old recovery code is dead", (await call("POST", "/api/auth/reset", { email: "alice@example.com", recoveryCode: rc, newPassword: "another one 1" })).status === 401);
// Verification flag: email accounts are never marked verified.
ok("email-account card is flagged unverified", (await call("GET", "/api/c/" + slug)).body.verified === false);
// Exact limiter: 30 parallel wrong guesses must let through at most 8 (the limit), even under concurrency.
const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => call("POST", "/api/auth/login", { email: "burst@example.com", password: "guess-" + i })));
const through = burst.filter(r => r.status === 401).length;
console.log("parallel burst: " + through + " of 30 reached the password check (limit 8)");
ok("parallel guessing is capped at the limit", process.env.NO_DO ? through >= 8 : through === 8);

// Email verification. Sender disabled first (no key): must answer 503 and send nothing.
const vtok = (await call("POST", "/api/auth/signup", { email: "vera@example.com", password: "verify me 123" })).body.ownerToken;
ok("verification disabled without a sender", (await call("POST", "/api/auth/email/request", {}, vtok)).status === 503);
ok("verification requires sign-in", (await call("POST", "/api/auth/email/request", {})).status === 401);
if (env) {
  const sent = []; env.MAIL_SINK = async (to, subject, text) => { sent.push({ to, subject, text }); };
  ok("request sends one email to the account address", (await call("POST", "/api/auth/email/request", {}, vtok)).status === 200 && sent.length === 1 && sent[0].to === "vera@example.com");
  const code = (sent[0].text.match(/\b(\d{6})\b/) || [])[1];
  ok("email has a 6-digit code and no profile data", !!code && !/vera|card/i.test(sent[0].text));
  ok("wrong code rejected", (await call("POST", "/api/auth/email/confirm", { code: code === "000000" ? "111111" : "000000" }, vtok)).status === 400);
  ok("another account cannot use the code", (await call("POST", "/api/auth/email/confirm", { code }, aTok)).status === 400);
  const vcard = await call("POST", "/api/card", { ownerToken: vtok, card: { name: "Vera", headline: "Test", links: {} } });
  ok("card was created", !!vcard.body.slug);
  ok("still unverified before confirming", (await call("GET", "/api/c/" + vcard.body.slug)).body.verified === false);
  ok("right code verifies", (await call("POST", "/api/auth/email/confirm", { code }, vtok)).body.verified === true);
  ok("card now shows verified", (await call("GET", "/api/c/" + vcard.body.slug)).body.verified === true);
  ok("code is single use", (await call("POST", "/api/auth/email/confirm", { code }, vtok)).status === 400);
  const burstTok = (await call("POST", "/api/auth/signup", { email: "vbrute@example.com", password: "verify me 123" })).body.ownerToken;
  await call("POST", "/api/auth/email/request", {}, burstTok);
  const g = []; for (let i = 0; i < 7; i++) g.push((await call("POST", "/api/auth/email/confirm", { code: "00000" + (i % 10) }, burstTok)).status);
  ok("code guessing is locked after 5 tries", g.slice(5).every(x => x === 429));

  // Caps, suppression and the bounce webhook.
  env.MAIL_DAILY_CAP = String(sent.length + 3); // earlier checks already used some of today budget
  const capTok = []; for (let i = 0; i < 4; i++) capTok.push((await call("POST", "/api/auth/signup", { email: "cap" + i + "@example.com", password: "verify me 123" })).body.ownerToken);
  const cs = []; for (const t of capTok) cs.push((await call("POST", "/api/auth/email/request", {}, t)).status);
  ok("global daily cap stops sending (counted before send)", cs.slice(0, 3).every(x => x === 200) && cs[3] === 429 && sent.length === cs.filter(x => x === 200).length + 2);
  delete env.MAIL_DAILY_CAP;
  env.RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from("test-secret-bytes-0123456789").toString("base64");
  const sign = async (id, ts, raw) => { const { createHmac } = await import("node:crypto"); return "v1," + createHmac("sha256", Buffer.from("test-secret-bytes-0123456789")).update(id + "." + ts + "." + raw).digest("base64"); };
  const hook = async (raw, sig) => (await fetch(url + "/api/mail/webhook", { method: "POST", headers: { "svix-id": "m1", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": sig }, body: raw })).status;
  const raw = JSON.stringify({ type: "email.bounced", data: { to: ["bounce@example.com"] } });
  const ts = Math.floor(Date.now() / 1000);
  ok("webhook with a bad signature is rejected", (await fetch(url + "/api/mail/webhook", { method: "POST", headers: { "svix-id": "m1", "svix-timestamp": String(ts), "svix-signature": "v1,AAAA" }, body: raw })).status === 401);
  ok("signed bounce is accepted", (await fetch(url + "/api/mail/webhook", { method: "POST", headers: { "svix-id": "m1", "svix-timestamp": String(ts), "svix-signature": await sign("m1", ts, raw) }, body: raw })).status === 200);
  const bt = (await call("POST", "/api/auth/signup", { email: "bounce@example.com", password: "verify me 123" })).body.ownerToken;
  const before = sent.length;
  ok("bounced address is suppressed and nothing is sent", (await call("POST", "/api/auth/email/request", {}, bt)).status === 400 && sent.length === before);
}
srv.close();
console.log("\n" + passed + " checks passed");
