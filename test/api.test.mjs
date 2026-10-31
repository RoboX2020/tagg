// End-to-end API test: signup, login, scan-to-connect, consent, mutual saving, private notes, location. Run: node test/api.test.mjs
import assert from "node:assert/strict";
import { start } from "./serve.mjs";
// Set TAGG_API to run the same checks against a deployed worker (use a staging worker: it creates accounts).
const { srv, url, env } = process.env.TAGG_API ? { srv: { close() {} }, url: process.env.TAGG_API } : await start(8799);
if (env) env.SIGNUP_PER_HOUR = "200"; // this test signs up many accounts from one address
let passed = 0;
globalThis.__rawCards = false;
async function call(method, path, body, tok) {
  // Test cards are complete profiles by default (name, headline, one detail) so the profile gate does not hide data in unrelated tests.
  if (path === "/api/card" && body && body.card && !globalThis.__rawCards) { body = { ...body, card: { ...body.card } }; if (!body.card.detail) body.card.detail = "Test detail"; if (!body.card.headline || body.card.headline.length < 3) body.card.headline = "Test headline"; }
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
{ const ft = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: ft, card: { name: "Fix Tester", headline: "h", links: {} } }, ft);
  const tt = (await call("POST", "/api/owner", {})).body.ownerToken; const tc = await call("POST", "/api/card", { ownerToken: tt, card: { name: "Fix Target", headline: "h", links: {} } }, tt);
  const sv1 = await call("POST", "/api/people", { slug: tc.body.slug, event: "Fix", location: { lat: 33.1, lon: -111.9, label: "x", acc: 12.4, at: "2026-10-30T18:00:00Z" } }, ft);
  ok("location keeps device accuracy (meters) and fix time", sv1.body.person.location.acc === 12 && sv1.body.person.location.at === "2026-10-30T18:00:00.000Z");
  const tt2 = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: tt2, card: { name: "Fix Two", headline: "h", links: {} } }, tt2);
  const sv2 = await call("POST", "/api/people", { slug: tc.body.slug, event: "Fix2", location: { lat: 33.1, lon: -111.9, acc: -5, at: "garbage" } }, tt2);
  ok("invalid accuracy or time is dropped, pin kept", sv2.body.person.location.lat === 33.1 && sv2.body.person.location.acc === undefined && sv2.body.person.location.at === undefined); }
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

// Account deletion.
const dTok = (await call("POST", "/api/auth/signup", { email: "del@example.com", password: "delete me 123" })).body.ownerToken;
const dCard = await call("POST", "/api/card", { ownerToken: dTok, card: { name: "Dee", headline: "Gone soon", links: {} } });
const keepTok = (await call("POST", "/api/auth/signup", { email: "keep@example.com", password: "keep me 1234" })).body.ownerToken;
const keepCard = await call("POST", "/api/card", { ownerToken: keepTok, card: { name: "Kay", headline: "Stays", links: {} } });
const save = await call("POST", "/api/connect", { slug: dCard.body.slug, requesterToken: keepTok, event: "test" });
const del = (b, t = dTok) => call("DELETE", "/api/account", b, t);
ok("delete needs the confirm word", (await del({ password: "delete me 123" })).status === 400);
ok("delete needs a signed-in owner", (await del({ confirm: "DELETE", password: "delete me 123" }, "nope-token-nope")).status === 401);
ok("delete rejects a wrong password", (await del({ confirm: "DELETE", password: "wrong wrong 1" })).status === 401);
ok("someone else cannot delete your account", (await del({ confirm: "DELETE", password: "delete me 123" }, keepTok)).status === 401);
ok("card still exists after failed attempts", (await call("GET", "/api/c/" + dCard.body.slug)).status === 200);
ok("delete with the password works", (await del({ confirm: "DELETE", password: "delete me 123" })).body.deleted === true);
ok("deleted card is gone", (await call("GET", "/api/c/" + dCard.body.slug)).status === 404);
ok("deleted owner token no longer works", (await call("GET", "/api/me", null, dTok)).status === 401);
ok("deleted login no longer works", (await call("POST", "/api/auth/login", { email: "del@example.com", password: "delete me 123" })).status === 401);
ok("email can sign up again fresh", (await call("POST", "/api/auth/signup", { email: "del@example.com", password: "delete me 123" })).status === 200);
ok("another account and its card are untouched", (await call("GET", "/api/c/" + keepCard.body.slug)).status === 200 && (await call("GET", "/api/me", null, keepTok)).status === 200);

// Reciprocal preservation: deleting one person must not erase the other person's own meeting record.
const eTok = (await call("POST", "/api/auth/signup", { email: "erin@example.com", password: "erin pass 123" })).body.ownerToken;
const fTok = (await call("POST", "/api/auth/signup", { email: "finn@example.com", password: "finn pass 123" })).body.ownerToken;
const eCard = await call("POST", "/api/card", { ownerToken: eTok, card: { name: "Erin Ro", headline: "Gone soon", links: {} } });
const fCard = await call("POST", "/api/card", { ownerToken: fTok, card: { name: "Finn Do", headline: "Stays", links: {} } });
const fc = await call("POST", "/api/connect", { slug: eCard.body.slug, requesterToken: fTok, event: "Demo Day", note: "Finn only note", location: { lat: 33.4, lon: -111.9, label: "Tempe, AZ", place: "Hayden Library" } });
const ei = await call("GET", "/api/inbox", null, eTok);
await call("POST", "/api/inbox/respond", { id: ei.body.requests[0].id, accept: true }, eTok);
const finnBefore = (await call("GET", "/api/people", null, fTok)).body.people.find(x => x.card.name === "Erin Ro");
ok("Finn has Erin saved before deletion", !!finnBefore && finnBefore.event === "Demo Day");
ok("Erin deletes her account", (await call("DELETE", "/api/account", { confirm: "DELETE", password: "erin pass 123" }, eTok)).body.deleted === true);
const finnAfter = (await call("GET", "/api/people", null, fTok)).body.people.find(x => x.card.name === "Erin Ro");
ok("Finn's own record of Erin survives with time, place and his note", !!finnAfter && finnAfter.metAt === finnBefore.metAt && finnAfter.location.place === "Hayden Library" && finnAfter.note.includes("Finn only"));
ok("Finn's own card and login are unaffected", (await call("GET", "/api/c/" + fCard.body.slug)).status === 200 && (await call("GET", "/api/me", null, fTok)).status === 200);

// Live scan ping + Save only
const sO = (await call("POST", "/api/auth/signup", { email: "sara@example.com", password: "sara pass 123" })).body.ownerToken;
const sCard = await call("POST", "/api/card", { ownerToken: sO, card: { name: "Sara Owner", headline: "Hosts", links: {} } });
const tS = (await call("POST", "/api/auth/signup", { email: "tom@example.com", password: "tom pass 123" })).body.ownerToken;
const tCard = await call("POST", "/api/card", { ownerToken: tS, card: { name: "Tom Scanner", headline: "Scans", links: {} } });
ok("owner inbox starts with no scans", (await call("GET", "/api/inbox", null, sO)).body.scans.length === 0);
ok("scan with a bad slug refused", (await call("POST", "/api/scan", { slug: "../x" })).status === 400);
ok("scan of an unknown card is 404", (await call("POST", "/api/scan", { slug: "zzzzzzzz" })).status === 404);
ok("anonymous scan accepted", (await call("POST", "/api/scan", { slug: sCard.body.slug })).body.ok === true);
const sc = (await call("GET", "/api/inbox", null, sO)).body.scans;
ok("owner sees one scan", sc.length === 1);
ok("scan carries only id and time, no identity", Object.keys(sc[0]).sort().join() === "at,id");
ok("scans are not visible to another account", (await call("GET", "/api/inbox", null, tS)).body.scans.length === 0);
for (let i = 0; i < 5; i++) await call("POST", "/api/scan", { slug: sCard.body.slug });
ok("repeat scans from one source are throttled", (await call("GET", "/api/inbox", null, sO)).body.scans.length <= 3);
ok("save-only needs sign-in", (await call("POST", "/api/people", { slug: sCard.body.slug })).status === 401);
const so = await call("POST", "/api/people", { slug: sCard.body.slug, event: "Expo", note: "Tom's private note", location: { lat: 33.4, lon: -111.9, label: "Tempe, AZ", place: "Expo Hall" } }, tS);
ok("save-only stores Sara in Tom's people with context and place", so.status === 200 && so.body.person.card.name === "Sara Owner" && so.body.person.note === "Tom's private note" && so.body.person.location.place === "Expo Hall");
ok("save-only is idempotent per card", (await call("GET", "/api/people", null, tS)).body.people.filter(x => x.slug === sCard.body.slug).length === 1);
ok("save-only sends nothing to the owner", (await call("GET", "/api/inbox", null, sO)).body.requests.length === 0 && (await call("GET", "/api/people", null, sO)).body.people.length === 0);
ok("save-only of your own card refused", (await call("POST", "/api/people", { slug: sCard.body.slug }, sO)).status === 400);
ok("save-only of an unknown card refused", (await call("POST", "/api/people", { slug: "zzzzzzzz" }, tS)).status === 404);

// Google account deletion needs a fresh Google sign-in for the same account. Google is stubbed here (no network).
if (env) {
  const realFetch = globalThis.fetch; const GCLIENT = "test-client";
  globalThis.fetch = async (u, init) => String(u).startsWith("https://oauth2.googleapis.com/tokeninfo")
    ? (() => { const c = new URL(u).searchParams.get("id_token"); const [sub, aud] = c.split("|"); return c === "bad" ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ sub, aud: aud || GCLIENT, email: sub + "@gmail.test", email_verified: "true", name: "G " + sub, picture: "" })); })()
    : realFetch(u, init);
  const g = await call("POST", "/api/auth/google", { credential: "gsub1|" });
  ok("google sign-in works with a valid token", g.status === 200 && !!g.body.ownerToken);
  const gTok = g.body.ownerToken;
  const gdel = c => call("DELETE", "/api/account", { confirm: "DELETE", credential: c }, gTok);
  ok("google delete without fresh sign-in refused", (await gdel(undefined)).status === 401);
  ok("google delete with a rejected token refused", (await gdel("bad")).status === 401);
  ok("google delete with another google account refused", (await gdel("gsub2|")).status === 401);
  ok("google delete with wrong audience refused", (await gdel("gsub1|other-app")).status === 401);
  ok("account still exists after refusals", (await call("GET", "/api/me", null, gTok)).status === 200);
  ok("google delete with fresh sign-in of the same account works", (await gdel("gsub1|")).body.deleted === true);
  ok("google token no longer works", (await call("GET", "/api/me", null, gTok)).status === 401);
  globalThis.fetch = realFetch;
}

// LinkedIn import from pasted text: preview, review, confirm. Gemini is mocked locally; hallucinated values must be dropped.
if (env) {
  const realFetch2 = globalThis.fetch;
  let geminiCalls = 0, linkedinCalls = 0, apifyCalls = 0, ghCalls = 0;
  globalThis.fetch = async (u, init) => {
    const us = String(u);
    if (us.includes("api.apify.com")) { apifyCalls++; if (init && init.method === "POST") return new Response(JSON.stringify([{ headline: "Student", experience: [{ position: "Lab Assistant", companyName: "ASU" }], education: [{ schoolName: "Arizona State University" }], profilePicture: { url: globalThis.__picUrl || "https://media.licdn.com/dms/image/test.jpg" }, location: { linkedinText: "Phoenix, Arizona" } }]), { status: 200 }); }
    if (us.includes("api.github.com/users/")) { ghCalls++; const h = us.split("/users/")[1]; if (h === "nobody-here") return new Response("{}", { status: 404 }); if (h === "limited-user") return new Response("{}", { status: 403 }); if (h === "down-user") throw new Error("net");
      return new Response(JSON.stringify({ login: h, name: "Gh Person", bio: "Builds robots", company: "ASU", location: "Tempe", followers: 5, public_repos: 7, avatar_url: "https://avatars.githubusercontent.com/u/1", blog: "" }), { status: 200 }); }
    if (us.includes("media.licdn.com")) { if (globalThis.__picCase === "big") return new Response(new Uint8Array(500000), { status: 200, headers: { "content-type": "image/jpeg" } }); if (globalThis.__picCase === "html") return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }); return new Response(new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70]), { status: 200, headers: { "content-type": "image/jpeg" } }); }
    if (us.includes("linkedin.com")) { linkedinCalls++; return new Response("", { status: 999 }); }
    return realFetch2(u, init);
  };
  env.AI = { run: async () => {
      geminiCalls++;
      const out = { headline: "Robotics Engineering Student | Intern", titles: ["Software Engineering Intern", "CEO"], companies: ["Acme Robotics", "Google"], schools: ["Arizona State University", "Stanford University"], location: "Tempe, Arizona, United States" };
      return { response: out };
  } };
  const text = "Test Person\nRobotics Engineering Student | Intern\nTempe, Arizona, United States\nExperience\nSoftware Engineering Intern\nAcme Robotics - Internship\nEducation\nArizona State University\nBachelor of Science, Robotics Engineering";
  ok("import needs a signed-in owner", (await call("POST", "/api/import/linkedin", { text })).status === 401);
  ok("import rejects a non-LinkedIn link", (await call("POST", "/api/import/linkedin", { url: "https://evil.example/in/x", text }, aTok)).status === 400);
  ok("import rejects empty text", (await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", text: "hi" }, aTok)).status === 400);
  const pv = await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", text }, aTok);
  ok("import returns a preview", pv.status === 200 && pv.body.previewId && pv.body.url === "https://www.linkedin.com/in/test-person");
  ok("values found in the text are kept", pv.body.fields.companies.includes("Acme Robotics") && pv.body.fields.schools.includes("Arizona State University") && pv.body.fields.titles.includes("Software Engineering Intern"));
  ok("values not in the text are dropped", !pv.body.fields.companies.includes("Google") && !pv.body.fields.schools.includes("Stanford University") && !pv.body.fields.titles.includes("CEO"));
  ok("linkedin.com is never fetched", linkedinCalls === 0 && geminiCalls === 1);
  ok("nothing is saved before confirm", ((await call("GET", "/api/c/" + slug)).body.enriched || {}).linkedin === undefined);
  ok("another owner cannot confirm my preview", (await call("POST", "/api/import/linkedin/confirm", { previewId: pv.body.previewId, fields: pv.body.fields }, bTok)).status === 410);
  const cf = await call("POST", "/api/import/linkedin/confirm", { previewId: pv.body.previewId, fields: { ...pv.body.fields, schools: ["Arizona State University"] } }, aTok);
  ok("confirm stores the reviewed fields with provenance", cf.status === 200 && cf.body.linkedin.source === "linkedin-pasted-text" && cf.body.linkedin.confirmedAt && cf.body.linkedin.school === "Arizona State University");
  ok("a preview works once", (await call("POST", "/api/import/linkedin/confirm", { previewId: pv.body.previewId, fields: pv.body.fields }, aTok)).status === 410);
  ok("scanners see the confirmed import", (await call("GET", "/api/c/" + slug)).body.enriched.linkedin.companies[0] === "Acme Robotics");
  ok("import can be removed", (await call("DELETE", "/api/import/linkedin", null, aTok)).body.ok === true && ((await call("GET", "/api/c/" + slug)).body.enriched || {}).linkedin === undefined);
  env.APIFY_TOKEN = "mock";
  ok("link import is off unless explicitly enabled", (await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", ownProfile: true }, aTok)).status === 503 && apifyCalls === 0);
  env.APIFY_ENABLED = "1";
  ok("link import needs the own-profile confirmation", (await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person" }, aTok)).status === 400 && apifyCalls === 0);
  const lk = await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", ownProfile: true }, aTok);
  ok("link import returns a preview from the provider", lk.status === 200 && lk.body.fields.schools[0] === "Arizona State University" && lk.body.fields.titles[0] === "Lab Assistant" && apifyCalls === 1);
  const lc = await call("POST", "/api/import/linkedin/confirm", { previewId: lk.body.previewId, fields: lk.body.fields }, aTok);
  ok("link import is stored with its own provenance only after confirm", lc.body.linkedin.source === "linkedin-link-import");
  for (let i = 0; i < 3; i++) await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", ownProfile: true }, aTok);
  ok("link imports have no daily cap, only the hourly abuse limit", (await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", ownProfile: true }, aTok)).status === 200);
  let ab; for (let i = 0; i < 4; i++) ab = await call("POST", "/api/import/linkedin", { url: "linkedin.com/in/test-person", ownProfile: true }, aTok);
  ok("link imports hit the hourly abuse limit", ab.status === 429);
  // Auto-import when the owner adds their own link, after the disclosure.
  const bTok0 = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: bTok0, card: { name: "Auto Person", headline: "h", links: {} } }, bTok0);
  const au = { url: "linkedin.com/in/auto-person", ownProfile: true, disclosure: "linkedin-auto-v1" };
  ok("auto import needs the disclosure", (await call("POST", "/api/import/linkedin/auto", { url: au.url, ownProfile: true }, bTok0)).status === 400);
  ok("auto import needs the own-profile tick", (await call("POST", "/api/import/linkedin/auto", { url: au.url, disclosure: au.disclosure }, bTok0)).status === 400);
  ok("auto import needs sign in", (await call("POST", "/api/import/linkedin/auto", au)).status === 401);
  const ar = await call("POST", "/api/import/linkedin/auto", au, bTok0);
  ok("auto import fills the card with provenance", ar.status === 200 && ar.body.linkedin.source === "linkedin-link-import" && ar.body.linkedin.autoImported === true && ar.body.linkedin.schools[0] === "Arizona State University");
  ok("same link is not imported twice", (await call("POST", "/api/import/linkedin/auto", au, bTok0)).status === 409);
  const ed = await call("POST", "/api/import/linkedin/edit", { fields: { headline: "Mine", titles: [], companies: ["ASU"], schools: [], location: "" } }, bTok0);
  ok("owner edits are kept and cleared fields are recorded", ed.status === 200 && ed.body.linkedin.titles.length === 0 && ed.body.linkedin.suppressed.includes("titles") && ed.body.linkedin.headline === "Mine");
  ok("remove then same link is still not re-imported", (await call("DELETE", "/api/import/linkedin", null, bTok0)).status === 200 && (await call("POST", "/api/import/linkedin/auto", au, bTok0)).status === 409);
  ok("a different link imports again", (await call("POST", "/api/import/linkedin/auto", { ...au, url: "linkedin.com/in/auto-person-2" }, bTok0)).status === 200);
  // GitHub enrichment on card save must not wipe confirmed LinkedIn details.
  const gTok = (await call("POST", "/api/owner", {})).body.ownerToken; const gc = await call("POST", "/api/card", { ownerToken: gTok, card: { name: "Gh Person", headline: "h", links: {} } }, gTok);
  await call("POST", "/api/import/linkedin/auto", { url: "linkedin.com/in/gh-person", ownProfile: true, disclosure: "linkedin-auto-v1" }, gTok);
  await call("POST", "/api/card", { ownerToken: gTok, card: { name: "Gh Person", headline: "h", links: { github: "https://github.com/octocat" } } }, gTok); await new Promise(r => setTimeout(r, 200));
  const gp = await call("GET", "/api/c/" + gc.body.slug);
  ok("saving a card with a GitHub link keeps confirmed LinkedIn details", gp.body.enriched && gp.body.enriched.linkedin && gp.body.enriched.linkedin.schools[0] === "Arizona State University");
  // GitHub informed import.
  const hTok = (await call("POST", "/api/owner", {})).body.ownerToken; const hc = await call("POST", "/api/card", { ownerToken: hTok, card: { name: "Hub Person", headline: "h", links: { github: "https://github.com/hub-person" } } }, hTok);
  await new Promise(r => setTimeout(r, 100)); ok("saving a card with a GitHub link reads nothing by itself", ghCalls === 0 && !((await call("GET", "/api/c/" + hc.body.slug)).body.enriched));
  const gh = { url: "github.com/hub-person", ownProfile: true, disclosure: "github-auto-v1" };
  ok("github import needs the notice", (await call("POST", "/api/import/github/auto", { url: gh.url, ownProfile: true }, hTok)).status === 400 && ghCalls === 0);
  ok("github import needs sign in", (await call("POST", "/api/import/github/auto", gh)).status === 401);
  ok("github import rejects a non-profile url", (await call("POST", "/api/import/github/auto", { ...gh, url: "github.com/a/b" }, hTok)).status === 400);
  const gr = await call("POST", "/api/import/github/auto", gh, hTok);
  ok("github import stores public profile with provenance", gr.status === 200 && gr.body.github.bio === "Builds robots" && gr.body.github.autoImported === true && gr.body.github.source === "github-public-api");
  ok("same github link is not imported twice", (await call("POST", "/api/import/github/auto", gh, hTok)).status === 409);
  const ge = await call("POST", "/api/import/github/edit", { fields: { name: "Hub", bio: "", company: "ASU", location: "" } }, hTok);
  ok("github edit keeps changes and records cleared fields", ge.status === 200 && ge.body.github.bio === null && ge.body.github.suppressed.includes("bio") && ge.body.github.name === "Hub");
  ok("github remove, then same link stays removed", (await call("DELETE", "/api/import/github", null, hTok)).status === 200 && (await call("POST", "/api/import/github/auto", gh, hTok)).status === 409);
  ok("github 404 fails gracefully", (await call("POST", "/api/import/github/auto", { ...gh, url: "github.com/nobody-here" }, hTok)).status === 422);
  const rlm = await call("POST", "/api/import/github/auto", { ...gh, url: "github.com/limited-user" }, hTok); ok("github rate limit fails gracefully", rlm.status === 503 && rlm.body.code === "rate-limited");
  ok("github network failure fails gracefully", (await call("POST", "/api/import/github/auto", { ...gh, url: "github.com/down-user" }, hTok)).status === 503);
  const lk2 = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: lk2, card: { name: "Both", headline: "h", links: {} } }, lk2);
  await call("POST", "/api/import/linkedin/auto", { url: "linkedin.com/in/both-person", ownProfile: true, disclosure: "linkedin-auto-v1" }, lk2); await call("POST", "/api/import/github/auto", { ...gh, url: "github.com/both-person" }, lk2);
  const bothSlug = await env.KV.get("own/" + lk2); const bothE = JSON.parse(await env.KV.get("enrich/" + bothSlug)); ok("github import keeps LinkedIn details in the same record", !!bothE.linkedin && !!bothE.github);
  // Profile picture: only with the v2 notice, copied from LinkedIn's image host, served from Tagg, removable.
  const pTok = (await call("POST", "/api/owner", {})).body.ownerToken; const pc = await call("POST", "/api/card", { ownerToken: pTok, card: { name: "Pic Person", headline: "h", links: {} } }, pTok);
  const v1 = await call("POST", "/api/import/linkedin/auto", { url: "linkedin.com/in/pic-v1", ownProfile: true, disclosure: "linkedin-auto-v1" }, pTok);
  ok("v1 notice imports no photo", v1.status === 200 && v1.body.linkedin.hasPhoto === false && (await fetch(url + "/api/photo/" + pc.body.slug)).status === 404);
  const v2 = await call("POST", "/api/import/linkedin/auto", { url: "linkedin.com/in/pic-v2", ownProfile: true, disclosure: "linkedin-auto-v2" }, pTok);
  const pr = await fetch(url + "/api/photo/" + pc.body.slug);
  ok("v2 notice copies the picture and Tagg serves it", v2.status === 200 && v2.body.linkedin.hasPhoto === true && pr.status === 200 && pr.headers.get("content-type") === "image/jpeg" && (await pr.arrayBuffer()).byteLength === 8);
  ok("photo response never leaks the provider url", !JSON.stringify(v2.body).includes("licdn"));
  ok("owner can remove only the photo", (await call("DELETE", "/api/profile-photo", null, pTok)).status === 200 && (await fetch(url + "/api/photo/" + pc.body.slug)).status === 404 && (await call("GET", "/api/c/" + pc.body.slug)).body.enriched.linkedin.schools.length > 0);
  for (const [label, pu, pcase] of [["off-host picture URL", "https://evil.example/pic.jpg", ""], ["oversize picture", "", "big"], ["non-image picture", "", "html"]]) {
    globalThis.__picUrl = pu || undefined; globalThis.__picCase = pcase;
    const nt = (await call("POST", "/api/owner", {})).body.ownerToken; const nc = await call("POST", "/api/card", { ownerToken: nt, card: { name: "Neg Pic", headline: "h", links: {} } }, nt);
    const nr = await call("POST", "/api/import/linkedin/auto", { url: "linkedin.com/in/neg-" + pcase + (pu ? "host" : ""), ownProfile: true, disclosure: "linkedin-auto-v2" }, nt);
    ok(label + ": details import, no picture stored", nr.status === 200 && nr.body.linkedin.hasPhoto === false && (await fetch(url + "/api/photo/" + nc.body.slug)).status === 404);
  }
  globalThis.__picUrl = undefined; globalThis.__picCase = "";
  ok("photo removal needs sign in", (await call("DELETE", "/api/profile-photo")).status === 401);
  let rl; for (let i = 0; i < 7; i++) rl = await call("POST", "/api/import/linkedin", { text }, aTok);
  ok("imports are rate limited", rl.status === 429);
  globalThis.fetch = realFetch2;
}

// Opening a saved person refreshes their shared card; private fields stay; removed fields are not resurrected.
{
  const own = (await call("POST", "/api/owner", {})).body.ownerToken;
  const sc = (await call("POST", "/api/card", { ownerToken: own, card: { name: "Rhea Stone", headline: "Old headline", email: "rhea@example.com", links: { github: "rhea-old" } } })).body;
  const viewer = (await call("POST", "/api/owner", {})).body.ownerToken;
  await call("POST", "/api/card", { ownerToken: viewer, card: { name: "Viewer", headline: "v", links: {} } });
  const sv = (await call("POST", "/api/people", { slug: sc.slug, event: "Refresh Expo", note: "my private note", location: { lat: 1, lon: 2, label: "Somewhere" } }, viewer)).body.person;
  ok("a new save has an unauthenticated-free GET refuse", (await call("GET", "/api/people/" + sv.id)).status === 401);
  await call("POST", "/api/card", { ownerToken: own, card: { name: "Rhea Stone-Lee", headline: "New headline", links: {} } });
  const rf = await call("GET", "/api/people/" + sv.id, null, viewer);
  ok("opening a person returns their latest shared card", rf.body.cardStatus === "live" && rf.body.person.card.name === "Rhea Stone-Lee" && rf.body.person.card.headline === "New headline");
  ok("a field they removed is not restored from the old snapshot", !rf.body.person.card.links.github && !rf.body.person.card.email);
  ok("my private note, place and event are unchanged by refresh", rf.body.person.note === "my private note" && rf.body.person.event === "Refresh Expo" && rf.body.person.location.label === "Somewhere");
  ok("another user cannot refresh my saved person", (await call("GET", "/api/people/" + sv.id, null, own)).status === 404);
  // The friend confirms a LinkedIn import AFTER the viewer saved them: it must show when the viewer opens the person.
  if (env) {
    await env.KV.put("enrich/" + sc.slug, JSON.stringify({ linkedin: { headline: "Staff Engineer", titles: ["Engineer"], companies: ["Acme"], schools: ["MIT"], location: "Boston", source: "linkedin-pasted-text", confirmedAt: new Date().toISOString() } }));
    const rf2 = await call("GET", "/api/people/" + sv.id, null, viewer);
    ok("details the friend adds after you saved them appear when you open them", rf2.body.person.enriched && rf2.body.person.enriched.linkedin.schools[0] === "MIT" && rf2.body.person.note === "my private note");
  }
  const stored = (await call("GET", "/api/people", null, viewer)).body.people[0];
  ok("the refreshed card is stored as the latest known copy", stored.card.name === "Rhea Stone-Lee");
}
// "Did you mean": similar words come only from the user's own records, are labelled suggestions, and are never applied silently.
{
  env.AI = { run: async () => ({ response: "MODEL ANSWER" }) };
  const o1 = (await call("POST", "/api/owner", {})).body.ownerToken, o2 = (await call("POST", "/api/owner", {})).body.ownerToken;
  const mkc = async (t, n, h) => (await call("POST", "/api/card", { ownerToken: t, card: { name: n, headline: h, links: {} } })).body;
  await mkc(o1, "Me", "x");
  const p1 = await mkc(o2, "Dana Webb", "Engineer"); const p2 = await mkc((await call("POST", "/api/owner", {})).body.ownerToken, "Eli Cho", "Designer");
  await call("POST", "/api/people", { slug: p1.slug, event: "ISTB Open House" }, o1); await call("POST", "/api/people", { slug: p2.slug, event: "Cal Hacks" }, o1);
  const hs = await call("POST", "/api/ask", { q: "Who did I meet from HSTB?" }, o1);
  ok("a misheard acronym returns a suggestion, not a model guess", hs.body.suggestions && hs.body.suggestions[0].heard === "HSTB" && hs.body.suggestions[0].meant === "ISTB" && hs.body.exact === false && hs.body.answer !== "MODEL ANSWER");
  ok("suggested people come from the user's own saved records", hs.body.suggestions[0].people.length === 1 && hs.body.suggestions[0].people[0].name === "Dana Webb");
  ok("the answer says it is a suggestion, not a confirmed match", /suggestion, not a confirmed match/.test(hs.body.answer) && /nothing in your saved people/.test(hs.body.answer));
  ok("an exact term is answered normally with no suggestions", (await call("POST", "/api/ask", { q: "Who did I meet from ISTB?" }, o1)).body.answer === "MODEL ANSWER");
  const none = await call("POST", "/api/ask", { q: "Who did I meet from ZZQX?" }, o1);
  ok("nothing similar means no invented suggestion", !none.body.suggestions);
  ok("another user's records are never suggested", !(await call("POST", "/api/ask", { q: "Who did I meet from HSTB?" }, o2)).body.suggestions);
}
// Several plausible interpretations: every qualifying candidate group is returned with all of its people, not only the first.
{
  const o1 = (await call("POST", "/api/owner", {})).body.ownerToken;
  await call("POST", "/api/card", { ownerToken: o1, card: { name: "Me", headline: "x", links: {} } });
  const mkp = async (n, ev) => { const t = (await call("POST", "/api/owner", {})).body.ownerToken; const c = (await call("POST", "/api/card", { ownerToken: t, card: { name: n, headline: "h", links: {} } })).body; await call("POST", "/api/people", { slug: c.slug, event: ev }, o1); };
  await mkp("Ana One", "ISTB Mixer"); await mkp("Ben Two", "ISTB Mixer"); await mkp("Cy Three", "ASTB Summit"); await mkp("Di Four", "HSTA Day"); await mkp("Ed Five", "Cal Hacks");
  const r = await call("POST", "/api/ask", { q: "Who did I meet at HSTB?" }, o1);
  const m = Object.fromEntries((r.body.suggestions || []).map(s => [s.meant, s.people.map(p => p.name).sort().join()]));
  ok("ambiguity returns every plausible interpretation as its own group", Object.keys(m).sort().join() === "ASTB,HSTA,ISTB");
  ok("each group lists all its people", m.ISTB === "Ana One,Ben Two" && m.ASTB === "Cy Three" && m.HSTA === "Di Four");
  ok("unrelated records are not suggested", !JSON.stringify(r.body.suggestions).includes("Ed Five"));
  ok("the answer text names each interpretation", /ISTB/.test(r.body.answer) && /ASTB/.test(r.body.answer) && /HSTA/.test(r.body.answer));
}
// Migrate must not duplicate people the server already has.
{
  const before = (await call("GET", "/api/people", null, bTok)).body.people;
  await call("POST", "/api/migrate", { ownerToken: bTok, people: before }, bTok);
  const after = (await call("GET", "/api/people", null, bTok)).body.people;
  ok("migrate does not duplicate people already on the server", after.length === before.length);
}
// Agent access (MCP): per-user, read-only, revocable tokens. Notes are excluded unless the owner opts in.
async function rpc(tok, method, params, id = 1) {
  const r = await fetch(url + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}
ok("MCP rejects a call with no token", (await rpc(null, "tools/list")).status === 401);
ok("MCP rejects an owner token (only tgm_ tokens)", (await rpc(bTok, "tools/list")).status === 401);
ok("creating an agent token needs sign-in", (await call("POST", "/api/tokens", { name: "x", scope: "people" })).status === 401);
ok("token scope must be one of the offered scopes", (await call("POST", "/api/tokens", { name: "x", scope: "everything" }, bTok)).status === 400);
const t1 = await call("POST", "/api/tokens", { name: "Test agent", scope: "people" }, bTok);
ok("token is returned once with the tgm_ prefix", t1.status === 200 && t1.body.token.startsWith("tgm_") && t1.body.scope === "people");
const tl = await call("GET", "/api/tokens", null, bTok);
ok("token list never contains the secret", tl.body.tokens.length === 1 && !JSON.stringify(tl.body).includes(t1.body.token));
const init = await rpc(t1.body.token, "initialize", { protocolVersion: "2025-03-26" });
ok("MCP initialize works", init.body.result.serverInfo.name === "tagg" && init.body.result.capabilities.tools);
ok("MCP lists four read-only tools", (await rpc(t1.body.token, "tools/list")).body.result.tools.map(x => x.name).join() === "search_people,get_person,friends_of_friends,list_events");
const sp = await rpc(t1.body.token, "tools/call", { name: "search_people", arguments: { query: "Alice" } });
const spo = JSON.parse(sp.body.result.content[0].text);
ok("MCP search finds the saved person without private notes", spo.people.length === 1 && spo.people[0].name === "Alice Ng" && !JSON.stringify(spo).includes("Bob only") && !("privateNote" in spo.people[0]));
ok("MCP marks identity as not verified by Tagg", /not verified/.test(spo.people[0].cardIdentity));
ok("MCP does not see other users' people", JSON.parse((await rpc(t1.body.token, "tools/call", { name: "search_people", arguments: { query: "Tom" } })).body.result.content[0].text).people.length === 0);
ok("MCP exposes no write tools", (await rpc(t1.body.token, "tools/call", { name: "delete_person", arguments: { id: "x" } })).body.error.code === -32602);
const t2 = await call("POST", "/api/tokens", { name: "Notes agent", scope: "people+notes" }, bTok);
const spn = JSON.parse((await rpc(t2.body.token, "tools/call", { name: "search_people", arguments: { query: "Alice" } })).body.result.content[0].text);
ok("notes appear only on a token the owner opted in for notes", spn.people[0].privateNote && spn.people[0].privateNote.includes("Bob only"));
ok("another user cannot revoke Bob's token", (await call("DELETE", "/api/tokens/" + t1.body.id, null, aTok)).status === 404);
ok("owner can revoke a token", (await call("DELETE", "/api/tokens/" + t1.body.id, null, bTok)).body.revoked === true);
ok("a revoked token stops working immediately", (await rpc(t1.body.token, "tools/list")).status === 401);
ok("MCP notifications get 202", (await (async () => { const r = await fetch(url + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t2.body.token }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }); return r.status; })()) === 202);
// ---- Profile completion gate: incomplete viewers get the server to withhold other people's details ----
{
  const SECRET_EMAIL = "gate-alice@secret.invalid", SECRET_PHONE = "+1 555 0100 777", SECRET_DETAIL = "Builds gate-secret-widgets", SECRET_LI = "gate-secret-handle";
  const gAt = (await call("POST", "/api/owner", {})).body.ownerToken;
  const gAc = await call("POST", "/api/card", { ownerToken: gAt, card: { name: "Gate Alice", headline: "Robotics lead", detail: SECRET_DETAIL, email: SECRET_EMAIL, phone: SECRET_PHONE, links: { linkedin: "https://linkedin.com/in/" + SECRET_LI, github: "https://github.com/gate-alice" } } }, gAt);
  await env.KV.put("enrich/" + gAc.body.slug, JSON.stringify({ linkedin: { headline: "x", titles: ["Gate Title"], companies: ["Gate Co"], schools: ["Gate School"], location: "Gate City", importedAt: new Date().toISOString(), hasPhoto: true } }));
  const gBt = (await call("POST", "/api/owner", {})).body.ownerToken;
  globalThis.__rawCards = true;
  await call("POST", "/api/card", { ownerToken: gBt, card: { name: "Gate Bob", headline: "h", links: {} } }, gBt);
  globalThis.__rawCards = false;
  const st0 = await call("GET", "/api/profile/status", null, gBt);
  ok("status says an incomplete profile is missing headline and detail", st0.status === 200 && st0.body.complete === false && st0.body.missing.includes("headline") && st0.body.missing.includes("detail"));
  ok("status needs sign in", (await call("GET", "/api/profile/status")).status === 401);
  const sv = await call("POST", "/api/people", { slug: gAc.body.slug, event: "Gate Expo", note: "bob private note", location: { lat: 33.1, lon: -111.9, label: "Gate Place", acc: 9 } }, gBt);
  const raw = JSON.stringify(sv.body);
  const leaks = (t) => [SECRET_EMAIL, SECRET_PHONE, SECRET_DETAIL, SECRET_LI, "gate-alice", "Gate Title", "Gate School", gAc.body.slug].filter(x => t.includes(x));
  ok("save response to an incomplete viewer carries no hidden details", sv.status === 200 && leaks(raw).length === 0 && sv.body.person.locked === true);
  const lst = await call("GET", "/api/people", null, gBt); const gp = lst.body.people[0];
  ok("list withholds email, phone, links, detail, imports and the card slug", leaks(JSON.stringify(lst.body.people)).length === 0 && gp.card.name === "Gate Alice" && gp.card.headline === "Robotics lead" && gp.locked === true);
  ok("who they met and the viewer's own note, event and pin stay visible", gp.event === "Gate Expo" && gp.note === "bob private note" && gp.location.lat === 33.1 && gp.metAt);
  const one = await call("GET", "/api/people/" + gp.id, null, gBt);
  ok("opening one person is gated too and never says live", leaks(JSON.stringify(one.body)).length === 0 && one.body.person.locked === true && one.body.cardStatus === "locked");
  const nt = await call("PUT", "/api/people/" + gp.id, { note: "edited note" }, gBt);
  ok("editing a note works while locked and still withholds", nt.status === 200 && nt.body.person.note === "edited note" && leaks(JSON.stringify(nt.body)).length === 0);
  let prompt = ""; env.AI = { run: async (m, a) => { prompt = a.messages[0].content; return { response: "ok" }; } };
  await call("POST", "/api/ask", { q: "Who did I meet at Gate Expo?" }, gBt);
  ok("Ask never receives hidden details for locked people", prompt.includes("Gate Alice") && leaks(prompt).length === 0 && !prompt.includes("Gate Co"));
  const gm = await call("POST", "/api/tokens", { name: "gate agent", scope: "people" }, gBt);
  const mr = await rpc(gm.body.token, "tools/call", { name: "search_people", arguments: { query: "Gate Alice" } });
  ok("MCP never returns hidden details for locked people", leaks(JSON.stringify(mr.body)).length === 0 && JSON.stringify(mr.body).includes("Gate Alice"));
  const gr = await call("GET", "/api/graph", null, gBt);
  ok("graph export carries no slug for locked people", gr.body.nodes.every(n => !n.slug));
  // Complete the profile: unlocks immediately, within what Alice shares.
  await call("POST", "/api/card", { ownerToken: gBt, card: { name: "Gate Bob", headline: "Student", detail: "Studies robotics", links: {} } }, gBt);
  const st1 = await call("GET", "/api/profile/status", null, gBt);
  const un = (await call("GET", "/api/people", null, gBt)).body.people[0];
  ok("saving a complete profile unlocks the details at once", st1.body.complete === true && !un.locked && un.card.email === SECRET_EMAIL && un.card.detail === SECRET_DETAIL && un.card.links.github.includes("gate-alice") && un.enriched.linkedin.companies[0] === "Gate Co");
  ok("nothing was deleted by locking or unlocking: the stored note is intact", un.note === "edited note");
  // Alice removes her phone: unlock shows only what she still shares.
  await call("POST", "/api/card", { ownerToken: gAt, card: { name: "Gate Alice", headline: "Robotics lead", detail: SECRET_DETAIL, email: SECRET_EMAIL, phone: "", links: {} } }, gAt);
  const un2 = await call("GET", "/api/people/" + un.id, null, gBt);
  ok("unlocked view follows the subject's current sharing", un2.body.person.card.phone === "" && Object.keys(un2.body.person.card.links).length === 0);
  // A LinkedIn import counts as the useful detail, so nobody is forced to write one.
  const gCt = (await call("POST", "/api/owner", {})).body.ownerToken;
  globalThis.__rawCards = true; const gCc = await call("POST", "/api/card", { ownerToken: gCt, card: { name: "Gate Cara", headline: "Designer", links: {} } }, gCt); globalThis.__rawCards = false;
  const before = (await call("GET", "/api/profile/status", null, gCt)).body;
  await env.KV.put("enrich/" + gCc.body.slug, JSON.stringify({ linkedin: { titles: ["Designer"], companies: [], schools: [], importedAt: new Date().toISOString() } }));
  const after = (await call("GET", "/api/profile/status", null, gCt)).body;
  ok("an existing LinkedIn import completes the detail", before.complete === false && after.complete === true);
  env.AI = undefined;
}

// ---- Graph sharing: consent-based friends-of-friends ----
{
  const mk = async (name) => { const t = (await call("POST", "/api/owner", {})).body.ownerToken; const c = await call("POST", "/api/card", { ownerToken: t, card: { name, headline: "Engineer", detail: "Builds things", email: name.split(" ")[0].toLowerCase() + "@gf.invalid", links: {} } }, t); return { t, slug: c.body.slug, name }; };
  const A = await mk("Gf Alice"), B = await mk("Gf Bob"), C = await mk("Gf Cara");
  const save = (who, other, extra = {}) => call("POST", "/api/people", { slug: other.slug, event: "gf-event", note: "gf-private-note", location: { lat: 1.5, lon: 2.5, label: "gf-place" }, ...extra }, who.t);
  await save(A, B); await save(B, A); await save(B, C);
  const sh = (w, on) => call("PUT", "/api/graph/sharing", { on }, w.t);
  const gr = async (w) => (await call("GET", "/api/graph", null, w.t)).body;
  const hasC = (g) => g.nodes.some(n => n.name === "Gf Cara");
  const st0 = await call("GET", "/api/graph/sharing", null, A.t);
  ok("a new owner has sharing preselected but nothing is shared until they confirm", st0.body.choice === "preselected-on" && st0.body.needsChoice === true && st0.body.isNew === true);
  ok("sharing endpoints need sign-in and a boolean", (await call("GET", "/api/graph/sharing")).status === 401 && (await call("PUT", "/api/graph/sharing", { on: "yes" }, A.t)).status === 400);
  await sh(A, true); await sh(B, true);
  ok("without the third person's own consent nobody sees them", !hasC(await gr(A)));
  await sh(C, true);
  const g1 = await gr(A); const cn = g1.nodes.find(n => n.name === "Gf Cara");
  ok("friend of friend appears when viewer, middle and third person all share", !!cn && cn.type === "friend-of-friend" && !cn.slug && /^f_[0-9a-f]{16}$/.test(cn.id));
  const raw1 = JSON.stringify(g1);
  ok("graph carries names and edges only: no notes, places, emails, or slugs and events on third-party nodes and edges", !/gf-private-note|gf-place|@gf\.invalid/.test(raw1) && g1.nodes.filter(n => n.type === "friend-of-friend").every(n => Object.keys(n).sort().join() === "id,name,type") && g1.edges.filter(e => e.kind === "knows").every(e => Object.keys(e).sort().join() === "from,kind,to"));
  const cEdge = g1.edges.find(e => e.to === cn.id); ok("the edge goes through the person who knows them", !!cEdge && g1.nodes.find(n => n.id === cEdge.from).name === "Gf Bob");
  let prompt = ""; env.AI = { run: async (m, a) => { prompt = a.messages[0].content; return { response: "ok" }; } };
  await call("POST", "/api/ask", { q: "Who does Gf Bob know?" }, A.t);
  ok("Ask sees the friend of friend by name only", prompt.includes("FRIENDS OF FRIENDS") && prompt.includes("Gf Cara") && !prompt.includes("cara@gf.invalid"));
  const tk = await call("POST", "/api/tokens", { name: "gf agent", scope: "people" }, A.t);
  const mr = await rpc(tk.body.token, "tools/call", { name: "friends_of_friends", arguments: {} });
  ok("MCP friends_of_friends returns the same names only", JSON.stringify(mr.body).includes("Gf Cara") && !JSON.stringify(mr.body).includes("gf-private-note"));
  await sh(C, false);
  ok("the third person opting out removes them immediately", !hasC(await gr(A)));
  await sh(C, true); await sh(B, false);
  ok("the middle person opting out removes their network immediately", !hasC(await gr(A)));
  await sh(B, true);
  const before = hasC(await gr(A));
  await call("DELETE", "/api/people/" + (await call("GET", "/api/people", null, B.t)).body.people.find(x => x.card.name === "Gf Alice").id, null, B.t);
  ok("if the middle person removes the viewer, the viewer no longer sees their network", before === true && !hasC(await gr(A)));
  await save(B, A);
  const Dd = await mk("Gf Dan"); globalThis.__rawCards = true; const raw = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: raw, card: { name: "Gf Eve", headline: "h", links: {} } }, raw); globalThis.__rawCards = false;
  const E = { t: raw }; await sh(E, true);
  await call("POST", "/api/people", { slug: B.slug }, E.t); await call("POST", "/api/people", { slug: Dd.slug }, E.t);
  ok("a viewer with an incomplete profile gets no friends of friends", !hasC(await gr(E)) && (await gr(E)).nodes.every(n => n.type !== "friend-of-friend"));
  await env.KV.delete("gsh/" + A.t);
  const st1 = await call("GET", "/api/graph/sharing", null, A.t);
  ok("an existing owner with no recorded choice shares nothing and must choose", st1.body.choice === "unset" && st1.body.needsChoice === true && !hasC(await gr(A)));
  await env.KV.put("gsh/" + A.t, JSON.stringify({ on: true, ack: false, cohort: true }));
  const st2 = await call("GET", "/api/graph/sharing", null, A.t);
  ok("a test-cohort account shares until it chooses, with the notice still pending", st2.body.choice === "on-until-you-choose" && st2.body.needsChoice === true && st2.body.cohort === true && hasC(await gr(A)));
  await sh(A, false);
  ok("opting out of the cohort default takes effect at once", !hasC(await gr(A)));
  env.AI = undefined;
}

srv.close();
console.log("\n" + passed + " checks passed");
