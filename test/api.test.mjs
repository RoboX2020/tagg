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
const scanTok = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: scanTok, card: { name: "Scan Viewer", headline: "Viewer", detail: "Complete profile for scanning", links: {} } }, scanTok);
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
  ok("nothing is saved before confirm", ((await call("GET", "/api/c/" + slug, null, scanTok)).body.enriched || {}).linkedin === undefined);
  ok("another owner cannot confirm my preview", (await call("POST", "/api/import/linkedin/confirm", { previewId: pv.body.previewId, fields: pv.body.fields }, bTok)).status === 410);
  const cf = await call("POST", "/api/import/linkedin/confirm", { previewId: pv.body.previewId, fields: { ...pv.body.fields, schools: ["Arizona State University"] } }, aTok);
  ok("confirm stores the reviewed fields with provenance", cf.status === 200 && cf.body.linkedin.source === "linkedin-pasted-text" && cf.body.linkedin.confirmedAt && cf.body.linkedin.school === "Arizona State University");
  ok("a preview works once", (await call("POST", "/api/import/linkedin/confirm", { previewId: pv.body.previewId, fields: pv.body.fields }, aTok)).status === 410);
  ok("scanners see the confirmed import", (await call("GET", "/api/c/" + slug, null, scanTok)).body.enriched.linkedin.companies[0] === "Acme Robotics");
  ok("import can be removed", (await call("DELETE", "/api/import/linkedin", null, aTok)).body.ok === true && ((await call("GET", "/api/c/" + slug, null, scanTok)).body.enriched || {}).linkedin === undefined);
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
  const gp = await call("GET", "/api/c/" + gc.body.slug, null, scanTok);
  ok("saving a card with a GitHub link keeps confirmed LinkedIn details", gp.body.enriched && gp.body.enriched.linkedin && gp.body.enriched.linkedin.schools[0] === "Arizona State University");
  // GitHub informed import.
  const hTok = (await call("POST", "/api/owner", {})).body.ownerToken; const hc = await call("POST", "/api/card", { ownerToken: hTok, card: { name: "Hub Person", headline: "h", links: { github: "https://github.com/hub-person" } } }, hTok);
  await new Promise(r => setTimeout(r, 100)); ok("saving a card with a GitHub link reads nothing by itself", ghCalls === 0 && !((await call("GET", "/api/c/" + hc.body.slug, null, scanTok)).body.enriched));
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
  ok("owner can remove only the photo", (await call("DELETE", "/api/profile-photo", null, pTok)).status === 200 && (await fetch(url + "/api/photo/" + pc.body.slug)).status === 404 && (await call("GET", "/api/c/" + pc.body.slug, null, scanTok)).body.enriched.linkedin.schools.length > 0);
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
  ok("status says an incomplete profile is missing headline and detail", st0.status === 200 && st0.body.complete === false && st0.body.missing === undefined && st0.body.score === undefined);
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

// ---- QR gate: public card is a minimal preview unless the viewer is the owner or has a complete profile ----
{
  const ot = (await call("POST", "/api/owner", {})).body.ownerToken;
  const oc = await call("POST", "/api/card", { ownerToken: ot, card: { name: "Qr Owner", headline: "Maker", detail: "QRsecretdetail", email: "qr-owner@secret.invalid", phone: "+1 555 0177", links: { github: "https://github.com/qr-secret-handle" } } }, ot);
  await env.KV.put("enrich/" + oc.body.slug, JSON.stringify({ linkedin: { titles: ["QR Title"], companies: ["QR Co"], schools: [], importedAt: new Date().toISOString() } }));
  const leak = (b) => ["qr-owner@secret", "555 0177", "QRsecretdetail", "qr-secret-handle", "QR Co", "QR Title"].filter(x => JSON.stringify(b).includes(x));
  const anon = await call("GET", "/api/c/" + oc.body.slug);
  ok("anonymous scan gets name and headline only, with no hidden fields anywhere in the response", anon.status === 200 && anon.body.locked === true && anon.body.card.name === "Qr Owner" && anon.body.card.headline === "Maker" && leak(anon.body).length === 0 && anon.body.enriched === null);
  const inc = (await call("POST", "/api/owner", {})).body.ownerToken; globalThis.__rawCards = true; await call("POST", "/api/card", { ownerToken: inc, card: { name: "Half Viewer", headline: "h", links: {} } }, inc); globalThis.__rawCards = false;
  const half = await call("GET", "/api/c/" + oc.body.slug, null, inc);
  ok("a scanner with an incomplete profile also gets the preview only", half.body.locked === true && leak(half.body).length === 0);
  const full = await call("GET", "/api/c/" + oc.body.slug, null, scanTok);
  ok("a scanner with a complete profile gets the full card", !full.body.locked && full.body.card.email === "qr-owner@secret.invalid" && full.body.enriched.linkedin.companies[0] === "QR Co");
  const own = await call("GET", "/api/c/" + oc.body.slug, null, ot);
  ok("the owner always gets their own full card", !own.body.locked && own.body.card.detail === "QRsecretdetail");
  const bad = await call("GET", "/api/c/" + oc.body.slug, null, "not-a-real-token-123456");
  ok("an unknown token is treated as anonymous", bad.body.locked === true && leak(bad.body).length === 0);
}

{
  const realFetch3 = globalThis.fetch; let nomCalls = 0, lastUA = ""; const nomTimes = [];
  globalThis.fetch = async (u, init) => {
    if (!String(u).startsWith("https://nominatim.openstreetmap.org/reverse")) return realFetch3(u, init);
    nomCalls++; nomTimes.push(Date.now()); lastUA = (init && init.headers && init.headers["User-Agent"]) || "";
    const q = new URL(u).searchParams;
    const body = q.get("lat").startsWith("33.41") ? { name: "Memorial Union", category: "amenity", type: "university", address: { amenity: "Memorial Union", city: "Tempe", state: "Arizona" } }
      : { name: "Mill Avenue", category: "highway", type: "residential", address: { road: "Mill Avenue", city: "Tempe", state: "Arizona" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const bad = await call("GET", "/api/place?lat=x&lon=1");
  ok("place lookup rejects bad coordinates", bad.status === 400);
  const a1 = await call("GET", "/api/place?lat=33.41744&lon=-111.93469");
  ok("place lookup returns a named venue with OpenStreetMap as the source", a1.status === 200 && a1.body.place === "Memorial Union" && a1.body.poi === true && a1.body.source === "OpenStreetMap" && a1.body.label === "Tempe, Arizona");
  ok("place lookup sends a real User-Agent", /Tagg/.test(lastUA));
  const a2 = await call("GET", "/api/place?lat=33.417441&lon=-111.934689");
  ok("nearby repeat is served from cache without another upstream call", a2.body.cached === true && nomCalls === 1);
  nomTimes.length = 0;
  const burst = await Promise.all([1, 2, 3, 4, 5].map(i => call("GET", "/api/place?lat=" + (50 + i) + ".1&lon=-100.5")));
  const okN = burst.filter(x => x.status === 200).length, refused = burst.filter(x => x.status === 429).length;
  const gaps = nomTimes.slice(1).map((t, i) => t - nomTimes[i]);
  ok("a parallel burst is paced to at least 1 second between upstream calls", okN >= 2 && gaps.length === okN - 1 && gaps.every(g => g >= 1000));
  ok("calls whose slot is too far away are refused, not sent upstream", refused >= 1 && okN + refused === 5);
  const r1 = await call("GET", "/api/place?lat=40.00001&lon=-100.5");
  ok("a road is not presented as a venue", r1.body.poi === false && r1.body.place === "Mill Avenue");
  const ot3 = (await call("POST", "/api/owner", {})).body.ownerToken;
  const cc = await call("POST", "/api/card", { ownerToken: ot3, card: { name: "Pl Owner", headline: "Maker", detail: "Building", links: {} } }, ot3);
  const viewer = (await call("POST", "/api/owner", {})).body.ownerToken;
  const sv = await call("POST", "/api/people", { slug: cc.body.slug, location: { lat: 33.41744, lon: -111.93469, place: "Memorial Union", label: "Tempe, Arizona", placeSource: "OpenStreetMap", acc: 12 } }, viewer);
  ok("saved meeting keeps the OpenStreetMap place as a guess with accuracy", sv.status < 300);
  const lst = (await call("GET", "/api/people", null, viewer)).body.people;
  const pid = lst[0] && lst[0].id;
  ok("stored place is marked as a guess", lst[0] && lst[0].location && lst[0].location.guess === true && lst[0].location.placeSource === "OpenStreetMap");
  const ed = await call("PUT", "/api/people/" + pid, { placeName: "Coffee with Sam" }, viewer);
  const lst2 = (await call("GET", "/api/people", null, viewer)).body.people;
  ok("owner can edit the place, which is then marked as typed by them", lst2[0].location.place === "Coffee with Sam" && lst2[0].location.guess === false && lst2[0].location.placeSource === "you" && lst2[0].location.lat === 33.41744);
  globalThis.fetch = realFetch3;
}

{
  const mkc = async (card, photo) => { const tk = (await call("POST", "/api/owner", {})).body.ownerToken; globalThis.__rawCards = true; const c = await call("POST", "/api/card", { ownerToken: tk, card }, tk); globalThis.__rawCards = false; if (photo) await env.KV.put("photo/" + c.body.slug, "data:image/png;base64,AAAA"); return { tk, slug: c.body.slug }; };
  const done = async (o) => (await call("GET", "/api/profile/status", null, o.tk)).body;
  const name2 = await mkc({ name: "Any One", headline: "", links: {} });
  ok("name alone is 1 of 7 sections: locked", (await done(name2)).complete === false);
  const two = await mkc({ name: "Any Two", headline: "", email: "a@b.invalid", links: {} });
  ok("name + contact is 2 of 7: still locked", (await done(two)).complete === false);
  const a3 = await mkc({ name: "Any Three", headline: "", links: { github: "https://github.com/x" } }, true);
  ok("name + link + photo is 3 of 7: unlocked, with no headline, about or contact", (await done(a3)).complete === true);
  const b3 = await mkc({ name: "Any Four", headline: "Maker", phone: "+1 555 0100", links: {} });
  ok("name + headline + phone is 3 of 7: unlocked with no social and no photo", (await done(b3)).complete === true);
  const c3 = await mkc({ name: "Any Five", headline: "Hi", detail: "ab", links: {} });
  ok("headline or about under their minimum length do not count", (await done(c3)).complete === false);
  const d3 = await mkc({ name: "Any Six", headline: "Maker", detail: "Builds robots", links: {} });
  ok("the old minimum (name + headline + about) still unlocks", (await done(d3)).complete === true);
  ok("status exposes only complete, never a count or the missing sections", Object.keys(await done(a3)).join() === "complete");
}

// ---- Notifications: built but OFF. Audience, dedup, wording, verified-address rule. (Local only: env exists.) ----
if (env) {
  const box = []; env.MAIL_SINK = async (to, subject, text) => { box.push({ to, subject, text }); };
  const mkv = async (email, name, verified) => { const o = (await call("POST", "/api/owner", {})).body.ownerToken; await env.KV.put("prof/" + o, JSON.stringify({ email, name, picture: "", sub: "email:" + email, emailVerified: verified })); const c = await call("POST", "/api/card", { ownerToken: o, card: { name, headline: "Maker", detail: "Builds things", links: {} } }, o); return { o, slug: c.body.slug }; };
  // OFF (default): a full request and accept sends nothing and records nothing.
  const offA = await mkv("off-a@n.invalid", "Off Alice", true), offB = await mkv("off-b@n.invalid", "Off Bob", true);
  const offReq = await call("POST", "/api/connect", { slug: offA.slug, requesterToken: offB.o }, null);
  const offInbox = (await call("GET", "/api/inbox", null, offA.o)).body.requests;
  await call("POST", "/api/inbox/respond", { id: offInbox[0].id, accept: true }, offA.o);
  ok("notifications OFF: no email sent and no in-app item for request or accept", box.length === 0 && (await call("GET", "/api/notify", null, offA.o)).body.items.length === 0 && (await call("GET", "/api/notify", null, offB.o)).body.items.length === 0);
  // ON
  await env.KV.put("cfg/notify", "on");
  const A = await mkv("on-a@n.invalid", "Maya Chen", true), B = await mkv("on-b@n.invalid", "Sam Roe", true), U = await mkv("on-u@n.invalid", "Una Unverified", false);
  const welcomes = box.filter(m => /^Welcome to Tagg$/.test(m.subject));
  ok("welcome emails: verified users only (2 of 3 new users), each to their own address, exact wording", welcomes.length === 2 && welcomes.map(m => m.to).sort().join() === "on-a@n.invalid,on-b@n.invalid" && welcomes[0].text.includes("Your Tagg card is ready.") && !welcomes[0].text.includes("Nothing is shared"));
  ok("welcome shows in-app for the unverified user too, but no email", (await call("GET", "/api/notify", null, U.o)).body.items.length === 1);
  box.length = 0;
  await call("POST", "/api/connect", { slug: A.slug, requesterToken: B.o }, null);
  ok("request: only the receiver is emailed, with the sender's name", box.length === 1 && box[0].to === "on-a@n.invalid" && box[0].subject === "Sam Roe wants to connect on Tagg" && box[0].text.includes("https://robox2020.github.io/tagg/#/people") && box[0].text.includes("Turn them off in Settings"));
  await call("POST", "/api/connect", { slug: A.slug, requesterToken: B.o }, null);
  ok("a duplicate request does not send again", box.length === 1);
  const inb = (await call("GET", "/api/inbox", null, A.o)).body.requests;
  box.length = 0;
  await call("POST", "/api/inbox/respond", { id: inb[0].id, accept: true }, A.o);
  ok("accepted: only the requester is emailed, the accepter is not", box.length === 1 && box[0].to === "on-b@n.invalid" && box[0].subject === "You are now connected with Maya Chen" && box[0].text.startsWith("Maya Chen accepted your connection request"));
  ok("no email leaks location, notes, contact or headline", box.every(m => !/Maker|Builds things|location|note/i.test(m.text)));
  await call("POST", "/api/notify/prefs", { email: false }, B.o);
  const C = await mkv("on-c@n.invalid", "Cy Dee", true);
  box.length = 0;
  await call("POST", "/api/connect", { slug: B.slug, requesterToken: C.o }, null);
  ok("email preference off: in-app only, no email", box.length === 0 && (await call("GET", "/api/notify", null, B.o)).body.items.some(x => x.type === "request"));
  ok("unauthenticated notify read is refused", (await call("GET", "/api/notify")).status === 401);
  box.length = 0;
  await call("POST", "/api/auth/email/request", {}, U.o);
  const codeMail = box.find(m => /Your Tagg code is \d{6}/.test(m.text));
  await call("POST", "/api/auth/email/confirm", { code: codeMail && codeMail.text.match(/\d{6}/)[0] }, U.o);
  ok("verifying the email sends the welcome email once (it could not go earlier)", box.filter(m => m.subject === "Welcome to Tagg").length === 1 && box.find(m => m.subject === "Welcome to Tagg").to === "on-u@n.invalid" && (await call("GET", "/api/notify", null, U.o)).body.items.filter(x => x.type === "welcome").length === 1);
  // ---- Web Push: real encryption and VAPID signing, transport stubbed (the push service host is intercepted, nobody is contacted) ----
  const wc = globalThis.crypto.subtle, u64 = (b) => Buffer.from(b).toString("base64url");
  const vk = await wc.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  env.VAPID_JWK = JSON.stringify(await wc.exportKey("jwk", vk.privateKey));
  const uaK = await wc.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPub = new Uint8Array(await wc.exportKey("raw", uaK.publicKey)), authSec = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1", keys: { p256dh: u64(uaPub), auth: u64(authSec) } };
  const PA = await mkv("push-a@n.invalid", "Pia Ark", true), PB = await mkv("push-b@n.invalid", "Quin Bell", true);
  ok("push subscribe needs sign-in", (await call("POST", "/api/push/subscribe", { subscription: sub })).status === 401);
  ok("push subscribe rejects a non-push host (no server-side requests to arbitrary URLs)", (await call("POST", "/api/push/subscribe", { subscription: { ...sub, endpoint: "https://evil.example.com/x" } }, PA.o)).status === 400);
  ok("push subscribe rejects http and bad keys", (await call("POST", "/api/push/subscribe", { subscription: { ...sub, endpoint: "http://fcm.googleapis.com/x" } }, PA.o)).status === 400 && (await call("POST", "/api/push/subscribe", { subscription: { ...sub, keys: { p256dh: "AAAA", auth: "AAAA" } } }, PA.o)).status === 400);
  const pk0 = (await call("GET", "/api/notify/prefs", null, PA.o)).body;
  ok("prefs report push available with the public key and zero devices", pk0.pushAvailable === true && /^[A-Za-z0-9_-]{87}$/.test(pk0.pushKey) && pk0.push === 0);
  ok("subscribe stores one device", (await call("POST", "/api/push/subscribe", { subscription: sub }, PA.o)).body.push === 1);
  const seen = []; const rf = globalThis.fetch;
  globalThis.fetch = async (u, init) => { if (String(u).startsWith("https://fcm.googleapis.com/")) { seen.push({ u: String(u), init }); return new Response("", { status: 201 }); } return rf(u, init); };
  await call("POST", "/api/connect", { slug: PA.slug, requesterToken: PB.o }, null);
  globalThis.fetch = rf;
  ok("a request pushes once to the receiver's device only", seen.length === 1 && seen[0].u === sub.endpoint && seen[0].init.headers["Content-Encoding"] === "aes128gcm" && seen[0].init.headers.TTL === "86400");
  const body = new Uint8Array(seen[0].init.body), salt = body.slice(0, 16), idl = body[20], asPub = body.slice(21, 21 + idl), ct = body.slice(21 + idl);
  const enc = new TextEncoder(), hk = async (sa, ik, info, n) => new Uint8Array(await wc.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sa, info }, await wc.importKey("raw", ik, "HKDF", false, ["deriveBits"]), n * 8));
  const sh = new Uint8Array(await wc.deriveBits({ name: "ECDH", public: await wc.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []) }, uaK.privateKey, 256));
  const ikm = await hk(authSec, sh, new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPub, ...asPub]), 32);
  const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nn = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(await wc.decrypt({ name: "AES-GCM", iv: nn }, await wc.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  const msg = JSON.parse(new TextDecoder().decode(plain.slice(0, plain.length - 1)));
  ok("the device can decrypt the push (RFC 8291) and it carries only the approved short text", plain[plain.length - 1] === 2 && msg.title === "Connection request" && msg.body === "Quin Bell wants to connect." && !/note|location|Maker/i.test(JSON.stringify(msg)));
  const auth = seen[0].init.headers.Authorization, m = auth.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  const vok = m && await wc.verify({ name: "ECDSA", hash: "SHA-256" }, vk.publicKey, Buffer.from(m[3], "base64url"), enc.encode(m[1] + "." + m[2]));
  ok("VAPID signature verifies against the published key and names the push service origin", vok && JSON.parse(Buffer.from(m[2], "base64url")).aud === "https://fcm.googleapis.com" && m[4] === pk0.pushKey);
  ok("the sender gets no push for their own request", PB && (await call("GET", "/api/notify", null, PB.o)).body.items.every(x => x.type !== "request"));
  globalThis.fetch = async (u, init) => { if (String(u).startsWith("https://fcm.googleapis.com/")) { seen.push(1); return new Response("", { status: 410 }); } return rf(u, init); };
  const inb2 = (await call("GET", "/api/inbox", null, PA.o)).body.requests; seen.length = 0;
  await call("POST", "/api/inbox/respond", { id: inb2[0].id, accept: true }, PA.o);
  ok("accepting pushes nothing to the accepter's own device", seen.length === 0);
  const PC = await mkv("push-c@n.invalid", "Cal Dune", true); await call("POST", "/api/connect", { slug: PA.slug, requesterToken: PC.o }, null);
  globalThis.fetch = rf;
  ok("an expired device (410) is dropped", (await call("GET", "/api/notify/prefs", null, PA.o)).body.push === 0);
  await call("POST", "/api/push/subscribe", { subscription: sub }, PA.o);
  ok("unsubscribe removes the device", (await call("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint }, PA.o)).body.push === 0);
  delete env.VAPID_JWK;
  ok("without keys, push is reported unavailable and subscribing is refused", (await call("GET", "/api/notify/prefs", null, PA.o)).body.pushAvailable === false && (await call("POST", "/api/push/subscribe", { subscription: sub }, PA.o)).status === 503);
  // ---- Scan alert: separate switch, anonymous wording, throttled ----
  const SO = await mkv("scan-o@n.invalid", "Ola Park", true); const pushes = []; env.PUSH_SINK = async (sb, pay) => { pushes.push(pay); return "ok"; };
  await call("POST", "/api/push/subscribe", { subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/scan-ep", keys: { p256dh: Buffer.from(new Uint8Array(65).fill(4)).toString("base64url"), auth: Buffer.from(new Uint8Array(16).fill(1)).toString("base64url") } } }, SO.o);
  box.length = 0; const nBefore = (await call("GET", "/api/notify", null, SO.o)).body.items.length;
  await call("POST", "/api/scan", { slug: SO.slug });
  ok("scan alert is OFF by default even with notifications on (no item, no push, no email)", (await call("GET", "/api/notify", null, SO.o)).body.items.length === nBefore && pushes.length === 0 && box.length === 0);
  await env.KV.put("cfg/notify-scan", "on");
  await env.KV.delete("nd/scan/" + SO.slug);
  await call("POST", "/api/scan", { slug: SO.slug });
  const sItems = (await call("GET", "/api/notify", null, SO.o)).body.items.filter(x => x.type === "scan");
  ok("scan alert (switch on): the card owner gets one in-app item with anonymous wording", sItems.length === 1 && sItems[0].title === "Your card was opened" && sItems[0].line === "Someone opened your Tagg card.");
  ok("scan alert pushes the same short text and emails the owner once, anonymously, with the footer", pushes.length === 1 && pushes[0].body === sItems[0].line && box.length === 1 && box[0].to === "scan-o@n.invalid" && box[0].subject === "Someone opened your Tagg card" && /Tagg cannot tell who it was/.test(box[0].text) && /Turn them off in Settings/.test(box[0].text) && !/Ola|met|not connected/.test(box[0].text));
  await call("POST", "/api/scan", { slug: SO.slug });
  ok("a second scan within 30 minutes does not alert again", (await call("GET", "/api/notify", null, SO.o)).body.items.filter(x => x.type === "scan").length === 1 && pushes.length === 1);
  await env.KV.delete("nd/scan/" + SO.slug);
  await call("POST", "/api/scan", { slug: SO.slug }, SO.o);
  ok("the owner opening their own card while signed in does not alert", (await call("GET", "/api/notify", null, SO.o)).body.items.filter(x => x.type === "scan").length === 1);
  await env.KV.delete("cfg/notify-scan"); delete env.PUSH_SINK;
  await env.KV.delete("cfg/notify");
}

// ---- Network first-access alert (own switch cfg/notify-net, event-driven): in-app and push only, no email, no names, once ----
if (env) {
  const { networkFirstAccessCheck } = await import("../worker/worker.js");
  await env.KV.put("cfg/notify", "on");
  const box = []; env.MAIL_SINK = async (to, subject, text) => { box.push({ to, subject, text }); };
  const mk = async (name, email) => { const o = (await call("POST", "/api/owner", {})).body.ownerToken; await env.KV.put("prof/" + o, JSON.stringify({ email, name, picture: "", sub: "email:" + email, emailVerified: true })); const c = await call("POST", "/api/card", { ownerToken: o, card: { name, headline: "Maker", detail: "Builds things", links: {} } }, o); await env.KV.put("gsh/" + o, JSON.stringify({ on: true, ack: true })); return { o, slug: c.body.slug }; };
  const V = await mk("Net Viewer", "nv@n.invalid"), M = await mk("Net Middle", "nm@n.invalid"), T = await mk("Net Third", "nt@n.invalid");
  const items = async (x) => (await call("GET", "/api/notify", null, x.o)).body.items.filter(i => i.type === "network");
  await call("POST", "/api/people", { slug: M.slug }, V.o); await call("POST", "/api/people", { slug: V.slug }, M.o); await call("POST", "/api/people", { slug: T.slug }, M.o); await call("POST", "/api/people", { slug: M.slug }, T.o);
  await networkFirstAccessCheck(env, T.o);
  ok("net alert is OFF without its own switch", (await items(V)).length === 0);
  await env.KV.put("cfg/notify-net", "on");
  box.length = 0;
  await networkFirstAccessCheck(env, T.o);
  const vi = await items(V);
  ok("viewer gets one in-app alert when a shared network first becomes visible", vi.length === 1 && vi[0].title === "Your network opened up" && vi[0].line === "People you may know through your connections are now visible. Open Map or People.");
  ok("the middle person is not alerted (sees nobody new); the third person is, because the mutual saves make the rule symmetric", (await items(M)).length === 0 && (await items(T)).length === 1);
  ok("the alert sends no email and names no one", box.length === 0 && !/Net (Middle|Third)/.test(JSON.stringify(vi)));
  await networkFirstAccessCheck(env, T.o); await networkFirstAccessCheck(env, V.o);
  ok("running the check again does not alert twice", (await items(V)).length === 1);
  const Z = await mk("Net Loner", "nl@n.invalid"); await networkFirstAccessCheck(env, Z.o);
  ok("someone who sees nobody is not alerted", (await items(Z)).length === 0);
  await env.KV.delete("cfg/notify-net"); await env.KV.delete("cfg/notify"); delete env.MAIL_SINK;
}

// ---- Free-tier exhaustion: a failing KV write must give a clean readable 503, not a raw platform error ----
if (env) {
  const op = env.KV.put; env.KV.put = async () => { throw new Error("KV put() limit exceeded for the day."); };
  const r = await call("POST", "/api/owner", {});
  env.KV.put = op;
  ok("when KV writes run out the API answers 503 with a readable message", r.status === 503 && /busy/i.test(r.body.error) && r.body.busy === true);
}

// ---- Claude connector OAuth: discovery, DCR, PKCE, approval in the app, refresh rotation, revoke, owner isolation ----
{
  const { createHash, randomBytes } = await import("node:crypto");
  const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const CB = "https://claude.ai/api/mcp/auth_callback";
  const mk2 = async (name, detail) => { const o = (await call("POST", "/api/owner", {})).body.ownerToken; await call("POST", "/api/card", { ownerToken: o, card: { name, headline: "Maker", detail, links: {} } }, o); return o; };
  const ownerA = await mk2("Oauth Alice", "a"), ownerB = await mk2("Oauth Bob", "b");
  const ownerF = await mk2("Only Alices Friend", "f");
  const fslug = (await call("GET", "/api/me", null, ownerF)).body.slug;
  const sv = await call("POST", "/api/people", { slug: fslug, note: "ALICE PRIVATE NOTE" }, ownerA);
  const pid = (await call("GET", "/api/people", null, ownerA)).body.people[0].id;
  await call("PUT", "/api/people/" + pid, { note: "ALICE PRIVATE NOTE" }, ownerA);
  const un = await fetch(url + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  ok("unauthenticated MCP call gets 401 with a resource_metadata pointer", un.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/.test(un.headers.get("www-authenticate")));
  const prm = await (await fetch(url + "/.well-known/oauth-protected-resource")).json();
  ok("protected resource metadata: resource equals the MCP URL, one authorization server", prm.resource === url + "/api/mcp" && prm.authorization_servers.length === 1 && prm.authorization_servers[0] === url);
  const as = await (await fetch(url + "/.well-known/oauth-authorization-server")).json();
  ok("authorization server metadata advertises S256, DCR, code and refresh", as.issuer === url && as.code_challenge_methods_supported.join() === "S256" && as.registration_endpoint === url + "/oauth/register" && as.grant_types_supported.includes("refresh_token") && as.token_endpoint_auth_methods_supported.includes("none"));
  const badReg = await fetch(url + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
  ok("registration refuses a redirect that is not Claude's callback or a loopback", badReg.status === 400 && (await badReg.json()).error === "invalid_redirect_uri");
  const regR = await fetch(url + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  const reg = await regR.json();
  ok("dynamic registration for Claude's callback succeeds (201, public client)", regR.status === 201 && /^tgc_/.test(reg.client_id) && reg.token_endpoint_auth_method === "none");
  const ver = b64u(randomBytes(32)), ch = b64u(createHash("sha256").update(ver).digest());
  const authz = (extra) => fetch(url + "/oauth/authorize?" + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: CB, state: "st1", code_challenge: ch, code_challenge_method: "S256", scope: "tagg.read", ...extra }), { redirect: "manual" });
  const wrongRu = await fetch(url + "/oauth/authorize?" + new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: ch, code_challenge_method: "S256" }), { redirect: "manual" });
  ok("authorize with an unregistered redirect never redirects", wrongRu.status === 400);
  const noPkce = await authz({ code_challenge_method: "plain" });
  ok("authorize without S256 PKCE returns an error to the callback", noPkce.status === 302 && new URL(noPkce.headers.get("location")).searchParams.get("error") === "invalid_request");
  const a1 = await authz({});
  const loc = new URL(a1.headers.get("location"));
  ok("authorize sends the user into the Tagg app consent screen", a1.status === 302 && loc.origin + loc.pathname === "https://robox2020.github.io/tagg/" && loc.hash.startsWith("#/connect-claude?req="));
  const rid = loc.hash.split("req=")[1];
  const info = await call("GET", "/api/oauth/request?req=" + rid);
  ok("the app can read who is asking (name and callback host only)", info.body.name === "Claude" && info.body.host === "claude.ai");
  ok("approving without being signed in is refused", (await call("POST", "/api/oauth/approve", { req: rid, approve: true })).status === 401);
  const ap = await call("POST", "/api/oauth/approve", { req: rid, approve: true }, ownerA);
  const cb = new URL(ap.body.redirect);
  ok("approval redirects to Claude's callback with a code and the same state", cb.origin + cb.pathname === CB && cb.searchParams.get("state") === "st1" && cb.searchParams.get("code").startsWith("tgcode_"));
  ok("a request id cannot be approved twice", (await call("POST", "/api/oauth/approve", { req: rid, approve: true }, ownerA)).status === 404);
  const tok = (body) => fetch(url + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  const code = cb.searchParams.get("code");
  const badV = await tok({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: b64u(randomBytes(32)) });
  ok("token exchange with a wrong PKCE verifier fails", badV.status === 400 && (await badV.json()).error === "invalid_grant");
  ok("the code is single use: a failed attempt burns it", (await tok({ grant_type: "authorization_code", code, redirect_uri: CB, client_id: reg.client_id, code_verifier: ver })).status === 400);
  const rid2 = (await authz({})).headers.get("location").split("req=")[1];
  const code2 = new URL((await call("POST", "/api/oauth/approve", { req: rid2, approve: true }, ownerA)).body.redirect).searchParams.get("code");
  const tr = await tok({ grant_type: "authorization_code", code: code2, redirect_uri: CB, client_id: reg.client_id, code_verifier: ver });
  const tj = await tr.json();
  ok("token exchange returns a bearer access token and a refresh token", tr.status === 200 && tj.token_type === "Bearer" && /^tgm_/.test(tj.access_token) && /^tgr_/.test(tj.refresh_token) && tj.expires_in === 3600);
  const mcp = (tk, method, params) => fetch(url + "/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tk }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  const init = await mcp(tj.access_token, "initialize", {});
  ok("the OAuth access token works on the MCP endpoint", init.status === 200 && init.body.result.serverInfo.name === "tagg");
  const lst = await mcp(tj.access_token, "tools/call", { name: "search_people", arguments: { query: "Alices Friend" } });
  const txt = JSON.stringify(lst.body);
  ok("it reads only Alice's people, and not her private notes (default scope)", /Only Alices Friend/.test(txt) && !/ALICE PRIVATE NOTE/.test(txt));
  const bobTools = await mcp(tj.access_token, "tools/call", { name: "search_people", arguments: { query: "Bob" } });
  ok("it cannot see any other owner's data", !/Oauth Bob/.test(JSON.stringify(bobTools.body)));
  const gl = await call("GET", "/api/tokens", null, ownerA);
  ok("the grant is listed in Alice's agent connections, read-only, and not in Bob's", gl.body.tokens.length === 1 && gl.body.tokens[0].name === "Claude" && gl.body.tokens[0].scope === "people" && (await call("GET", "/api/tokens", null, ownerB)).body.tokens.length === 0);
  const rf = await (await tok({ grant_type: "refresh_token", refresh_token: tj.refresh_token })).json();
  ok("refresh returns a new access and refresh token", /^tgm_/.test(rf.access_token) && rf.refresh_token !== tj.refresh_token);
  const reuse = await tok({ grant_type: "refresh_token", refresh_token: tj.refresh_token });
  ok("the old refresh token is dead after rotation (invalid_grant)", reuse.status === 400 && (await reuse.json()).error === "invalid_grant");
  ok("the old access token stops working after refresh", (await mcp(tj.access_token, "tools/list", {})).status === 401 && (await mcp(rf.access_token, "tools/list", {})).status === 200);
  const grantId = (await call("GET", "/api/tokens", null, ownerA)).body.tokens[0].id;
  ok("one grant per client name: reconnecting does not stack grants", (await call("GET", "/api/tokens", null, ownerA)).body.tokens.length === 1);
  ok("Bob cannot revoke Alice's grant", (await call("DELETE", "/api/tokens/" + grantId, null, ownerB)).status === 404);
  await call("DELETE", "/api/tokens/" + grantId, null, ownerA);
  ok("revoking in Settings kills the access token at once", (await mcp(rf.access_token, "tools/list", {})).status === 401);
  ok("and the refresh token", (await tok({ grant_type: "refresh_token", refresh_token: rf.refresh_token })).status === 400);
  const rid3 = (await authz({})).headers.get("location").split("req=")[1];
  const dn = await call("POST", "/api/oauth/approve", { req: rid3, approve: false }, ownerA);
  ok("denying redirects back with access_denied and no code", new URL(dn.body.redirect).searchParams.get("error") === "access_denied" && !new URL(dn.body.redirect).searchParams.get("code"));
  const rid4 = (await authz({})).headers.get("location").split("req=")[1];
  const nt = await call("POST", "/api/oauth/approve", { req: rid4, approve: true, notes: true }, ownerA);
  const t4 = await (await tok({ grant_type: "authorization_code", code: new URL(nt.body.redirect).searchParams.get("code"), redirect_uri: CB, client_id: reg.client_id, code_verifier: ver })).json();
  const nr = await mcp(t4.access_token, "tools/call", { name: "search_people", arguments: { query: "Alices Friend" } });
  ok("only when the owner ticks private notes does the grant include them", (await call("GET", "/api/tokens", null, ownerA)).body.tokens[0].scope === "people+notes" && /ALICE PRIVATE NOTE/.test(JSON.stringify(nr.body)));
}

srv.close();
console.log("\n" + passed + " checks passed");
