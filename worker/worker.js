// Tagg API - Cloudflare Worker. KV-backed card + people store with graph-shaped schema.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};
function j(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}
function rand(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}
function token() {
  const a = new Uint8Array(24); crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
}
async function getJSON(kv, key) { const v = await kv.get(key); return v ? JSON.parse(v) : null; }
function cleanCard(c) {
  if (!c || typeof c.name !== "string" || !c.name.trim()) return null;
  const links = {}; if (c.links && typeof c.links === "object") for (const k of ["linkedin","github","x","instagram","website"]) { if (typeof c.links[k] === "string" && c.links[k]) links[k] = c.links[k].slice(0, 300); }
  return {
    name: c.name.slice(0, 120), headline: (c.headline || "").slice(0, 200),
    email: (c.email || "").slice(0, 200), phone: (c.phone || "").slice(0, 40), links,
  };
}
async function enrichGithub(env, slug, card) {
  try {
    const gh = card.links && card.links.github;
    if (!gh) return;
    const m = gh.match(/github\.com\/([A-Za-z0-9-]+)/);
    if (!m) return;
    const ghHeaders = { "User-Agent": "tagg-app", "Accept": "application/vnd.github+json" };
    if (env.GITHUB_TOKEN) ghHeaders.Authorization = "Bearer " + env.GITHUB_TOKEN;
    const r = await fetch("https://api.github.com/users/" + m[1], { headers: ghHeaders });
    if (!r.ok) return;
    const u = await r.json();
    const enriched = { source: "github", fetchedAt: new Date().toISOString(), github: {
      login: u.login, name: u.name || null, bio: u.bio || null, company: u.company || null,
      avatar: u.avatar_url || null, followers: u.followers ?? null, repos: u.public_repos ?? null,
      location: u.location || null, blog: u.blog || null } };
    await env.KV.put("enrich/" + slug, JSON.stringify(enriched));
  } catch (e) { /* enrichment is best-effort */ }
}
// LinkedIn import (user-initiated, reviewed). LinkedIn's robots.txt and User Agreement forbid automated reading of profile pages
// and it answers server requests with HTTP 999, so Tagg never fetches linkedin.com. The owner pastes the text of their OWN profile
// (or its "Save to PDF" export); Cloudflare Workers AI (free tier) pulls out roles, employers, schools and place, and every extracted value must
// appear in the pasted text or it is dropped. Nothing is stored until the owner reviews it and confirms.
function parseLinkedinUrl(raw) {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = "https://" + t.replace(/^\/+/, "");
  let u; try { u = new URL(t); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!/^([a-z]{2,3}\.|www\.)?linkedin\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/in\/([^\/?#]{2,100})\/?$/);
  if (!m) return null;
  return "https://www.linkedin.com/in/" + m[1];
}
const clip = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
function asNames(x, max) {
  const arr = Array.isArray(x) ? x : x ? [x] : [];
  const out = [];
  for (const it of arr) { const n = clip(typeof it === "string" ? it : it && it.name, 120); if (n && !out.includes(n)) out.push(n); if (out.length >= max) break; }
  return out;
}
// URL-only import through Apify (the user's hackathon promo credits, free plan, hard monthly cap, no card). Used only when the
// signed-in owner types their own LinkedIn URL and confirms it is their own profile. Hard per-run charge cap; per-owner and global daily caps.
async function importViaApify(env, url) {
  const r = await fetch("https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items?maxTotalChargeUsd=0.01&timeout=60", {
    method: "POST", headers: { "Authorization": "Bearer " + env.APIFY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ profileScraperMode: "Profile details no email ($4 per 1k)", queries: [url] }), signal: AbortSignal.timeout(70000) });
  if (!r.ok) return { unavailable: "apify " + r.status };
  const items = await r.json().catch(() => null);
  const x = Array.isArray(items) ? items[0] : null;
  if (!x || x.error || (!x.experience && !x.education && !x.headline)) return null;
  const uniq = (arr, n) => asNames(arr.filter(Boolean), n);
  return {
    headline: clip(x.headline, 300),
    titles: uniq((x.experience || []).map(e => e && e.position), 5),
    companies: uniq((x.experience || []).map(e => e && e.companyName), 6),
    schools: uniq((x.education || []).map(e => e && e.schoolName), 6),
    location: clip(x.location && (x.location.linkedinText || (x.location.parsed && x.location.parsed.text)), 120)
  };
}
const AI_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.2-3b-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/google/gemma-3-12b-it", "@cf/qwen/qwen3-30b-a3b-fp8"];
const norm = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
async function extractProfile(env, text) {
  const prompt = "Extract facts from this pasted LinkedIn profile text. Copy values EXACTLY as written in the text. Never guess, infer or add anything that is not in the text. Leave a list empty if the text does not say. headline = the profile headline if present. titles = job titles held (current first). companies = employers (current first). schools = schools or universities attended. location = the place shown on the profile.\n\nTEXT:\n" + text;
  const schema = { type: "object", properties: { headline: { type: "string" }, titles: { type: "array", items: { type: "string" } }, companies: { type: "array", items: { type: "string" } }, schools: { type: "array", items: { type: "string" } }, location: { type: "string" } }, required: ["headline", "titles", "companies", "schools", "location"] };
  let raw = null, why = "";
  for (const m of AI_MODELS) {
    try {
      const r = await env.AI.run(m, { messages: [{ role: "system", content: "You extract facts from text and answer only with JSON." }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: schema }, max_tokens: 700, temperature: 0 });
      raw = typeof r.response === "string" ? JSON.parse(r.response) : r.response;
      if (raw && typeof raw === "object") break;
    } catch (e) { why += m.split("/").pop() + ": " + String(e && e.message || e).slice(0, 70) + " | "; }
  }
  if (!raw || typeof raw !== "object") return { unavailable: why || "no result" };
  const nt = norm(text);
  const keep = (arr, n) => asNames(Array.isArray(arr) ? arr : [], 12).filter(v => nt.includes(norm(v))).slice(0, n);
  const one = (v, n) => { const c = clip(v, n); return c && nt.includes(norm(c)) ? c : ""; };
  const out = { headline: one(raw.headline, 300), titles: keep(raw.titles, 5), companies: keep(raw.companies, 6), schools: keep(raw.schools, 6), location: one(raw.location, 120) };
  return (out.headline || out.titles.length || out.companies.length || out.schools.length || out.location) ? out : null;
}

// ---- Agent access (MCP). Per-user, read-only, revocable tokens. A token is shown once and only its SHA-256 is stored.
async function sha256hex(s) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), b => b.toString(16).padStart(2, "0")).join(""); }
const MCP_SCOPES = ["people", "people+notes"];
const MCP_TTL_MS = 90 * 86400000;
function mcpPerson(x, withNotes) {
  const li = x.enriched && x.enriched.linkedin ? x.enriched.linkedin : null;
  const o = { id: x.id, name: x.card && x.card.name, headline: (x.card && x.card.headline) || null, event: x.event || null, metAt: x.metAt || null, where: (x.location && x.location.label) || null };
  if (li) o.importedFromLinkedin = { roles: li.titles || [], companies: li.companies || [], schools: li.schools || [], location: li.location || null, note: "Entered or reviewed by the card owner. Tagg has not verified it." };
  if (!x.verified && x.card) o.cardIdentity = "as entered by the person; Tagg has not verified it";
  if (withNotes && x.note) o.privateNote = x.note;
  return o;
}
function mcpMatch(x, terms, withNotes) {
  const li = x.enriched && x.enriched.linkedin ? x.enriched.linkedin : {};
  const hay = [x.card && x.card.name, x.card && x.card.headline, x.event, x.location && x.location.label, li.headline, (li.titles || []).join(" "), (li.companies || []).join(" "), (li.schools || []).join(" "), li.location, withNotes ? x.note : ""].join(" ").toLowerCase();
  return terms.filter(t => hay.includes(t)).length;
}
const MCP_TOOLS = [
  { name: "search_people", description: "Search the people this Tagg user has met by name, headline, event, place, or imported work and school details. Read-only.", inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for, e.g. a company, school, event or name" } }, required: ["query"] } },
  { name: "get_person", description: "Get one saved person by id (from search_people or list_events).", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "list_events", description: "List the events where this user met people, with counts.", inputSchema: { type: "object", properties: {} } },
];
async function mcpCall(env, owner, scope, name, args) {
  const withNotes = scope === "people+notes";
  const people = await getPeople(env, owner);
  if (name === "search_people") {
    const terms = String((args && args.query) || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(t => t.length > 1).slice(0, 12);
    if (!terms.length) return { people: [] };
    return { people: people.map(x => ({ x, s: mcpMatch(x, terms, withNotes) })).filter(r => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 10).map(r => mcpPerson(r.x, withNotes)) };
  }
  if (name === "get_person") { const x = people.find(q => q.id === (args && args.id)); return x ? mcpPerson(x, withNotes) : { error: "not found" }; }
  if (name === "list_events") { const m = {}; for (const x of people) { const e = x.event || "(no event)"; m[e] = (m[e] || 0) + 1; } return { events: Object.keys(m).map(e => ({ event: e, people: m[e] })) }; }
  return null;
}
async function getPeople(env, owner) { return (await getJSON(env.KV, "ppl/" + owner)) || []; }
async function putPeople(env, owner, list) { await env.KV.put("ppl/" + owner, JSON.stringify(list.slice(0, 500))); }
function authOwner(req) { const h = req.headers.get("Authorization") || ""; return h.startsWith("Bearer ") ? h.slice(7) : null; }


// ---- v4: email/password accounts, rate limits, location cleaning ----
const PBKDF2_ITER = 100000; // Cloudflare Workers caps PBKDF2 at 100k iterations
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function hashPassword(pw, saltB64, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function newRecoveryCode() { return [rand(5), rand(5), rand(5), rand(5)].join("-"); }
// An identity counts as verified only when Google vouched for the email. Email/password accounts are unverified.
async function isVerified(env, owner) {
  const prof = owner ? await getJSON(env.KV, "prof/" + owner) : null;
  if (!prof || !prof.sub) return false;
  if (String(prof.sub).startsWith("email:")) return prof.emailVerified === true; // set only by /api/auth/email/confirm
  return true;
}

// ---- email verification (sender is optional; with no key configured the routes answer 503 and send nothing) ----
// Provider: Resend over plain HTTPS. Set secrets RESEND_API_KEY and MAIL_FROM (e.g. "Tagg <noreply@mail.example.com>").
// For tests, env.MAIL_SINK(to, subject, text) replaces the network call.
function mailEnabled(env) { return !!(env.MAIL_SINK || (env.RESEND_API_KEY && env.MAIL_FROM)); }
async function sendMail(env, to, subject, text) {
  if (env.MAIL_SINK) return env.MAIL_SINK(to, subject, text);
  const r = await fetch("https://api.resend.com/emails", { method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }) });
  if (!r.ok) throw new Error("mail provider " + r.status);
}
// Hard app-side send caps, counted BEFORE each send (so failed attempts and retries count too). Defaults sit under Resend's free limits
// (100/day, 3,000/month). A send that would pass a cap is refused, so the app can never ask the provider for more than this.
async function mailBudgetOk(env, to) {
  const d = new Date().toISOString();
  const day = Number(env.MAIL_DAILY_CAP) || 60, month = Number(env.MAIL_MONTHLY_CAP) || 1500;
  if (await overLimit(env, "mail/day/" + d.slice(0, 10), day, 86400)) return false;
  if (await overLimit(env, "mail/month/" + d.slice(0, 7), month, 2678400)) return false;
  if (await overLimit(env, "mail/to/" + to, 5, 86400)) return false;
  return true;
}
// Resend webhook (Svix-signed). Bounces and spam complaints put the address on a suppression list so we never mail it again.
async function verifyWebhook(env, req, raw) {
  const sec = env.RESEND_WEBHOOK_SECRET; if (!sec) return false;
  const id = req.headers.get("svix-id"), ts = req.headers.get("svix-timestamp"), sig = req.headers.get("svix-signature");
  if (!id || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", unb64(sec.replace(/^whsec_/, "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id + "." + ts + "." + raw)));
  return sig.split(" ").some(x => safeEqual(x.replace(/^v1,/, ""), want));
}
async function codeHash(owner, code) {
  return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner + ":" + code)));
}
// Verify a Google id_token (audience must be this app). Returns the token info or null.
async function verifyGoogle(env, credential) {
  if (typeof credential !== "string" || !credential) return null;
  const vr = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential));
  if (!vr.ok) return null;
  const idt = await vr.json();
  if (idt.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (idt.email_verified !== "true" && idt.email_verified !== true) return null;
  return idt;
}
function normEmail(e) { return typeof e === "string" ? e.trim().toLowerCase().slice(0, 200) : ""; }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Fixed-window attempt counter in KV (free tier). Returns true when the caller is over the limit.
async function overLimit(env, key, max, windowSec) {
  // Preferred: a Durable Object per key. It handles one request at a time, so the count is exact
  // even under parallel guessing. Falls back to the KV counter below if the binding is missing.
  if (env.RL) {
    const stub = env.RL.get(env.RL.idFromName(key));
    const r = await stub.fetch("https://rl/hit", { method: "POST", body: JSON.stringify({ max, windowSec }) });
    return (await r.json()).over === true;
  }
  const k = "rl/" + key;
  const n = parseInt((await env.KV.get(k)) || "0", 10);
  if (n >= max) return true;
  await env.KV.put(k, String(n + 1), { expirationTtl: Math.max(60, windowSec) });
  return false;
}
function cleanLocation(l) {
  if (!l || typeof l !== "object") return null;
  const ok = (v, lim) => typeof v === "number" && isFinite(v) && Math.abs(v) <= lim;
  const lat = ok(l.lat, 90) ? l.lat : null, lon = ok(l.lon, 180) ? l.lon : null;
  const label = typeof l.label === "string" ? l.label.slice(0, 200) : "";
  const place = typeof l.place === "string" ? l.place.slice(0, 160) : "";
  if (lat === null && lon === null && !label && !place) return null;
  return { lat: lat === null || lon === null ? null : lat, lon: lat === null || lon === null ? null : lon, label, place };
}
// Link an identity key (google sub or email) to an owner token, adopting/merging the device identity.
async function linkIdentity(env, authKey, deviceTok) {
  let linked = await env.KV.get(authKey);
  if (!linked) {
    linked = (deviceTok && (await env.KV.get("own/" + deviceTok)) !== null) ? deviceTok : token();
    if ((await env.KV.get("own/" + linked)) === null) { await env.KV.put("own/" + linked, ""); await putPeople(env, linked, []); }
    await env.KV.put(authKey, linked);
    return linked;
  }
  if (deviceTok && deviceTok !== linked && (await env.KV.get("own/" + deviceTok)) !== null) {
    const a = await getPeople(env, linked);
    const b = await getPeople(env, deviceTok);
    const seen = new Set(a.map(x => (x.slug || "") + "|" + x.card.name.toLowerCase() + "|" + x.metAt));
    let added = 0;
    for (const x of b) { const k = (x.slug || "") + "|" + x.card.name.toLowerCase() + "|" + x.metAt; if (!seen.has(k)) { a.push(x); added++; } }
    if (added) { a.sort((x, y) => (y.metAt || "").localeCompare(x.metAt || "")); await putPeople(env, linked, a); }
    const linkedSlug = await env.KV.get("own/" + linked);
    const deviceSlug = await env.KV.get("own/" + deviceTok);
    if (!linkedSlug && deviceSlug) {
      await env.KV.put("own/" + linked, deviceSlug);
      const rec = await getJSON(env.KV, "card/" + deviceSlug);
      if (rec) { rec.ownerToken = linked; await env.KV.put("card/" + deviceSlug, JSON.stringify(rec)); }
    }
  }
  return linked;
}

// Durable Object (SQLite-backed, available on the free plan): an exact fixed-window attempt counter.
export class RateLimiter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const { max, windowSec } = await req.json();
    const now = Date.now();
    let r = await this.state.storage.get("r");
    if (!r || r.resetAt < now) r = { n: 0, resetAt: now + windowSec * 1000 };
    if (r.n >= max) return Response.json({ over: true });
    r.n++;
    await this.state.storage.put("r", r);
    return Response.json({ over: false });
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Create an anonymous owner identity (no card yet).
    if (p === "/api/owner" && req.method === "POST") {
      const t = token();
      await env.KV.put("own/" + t, "");
      await putPeople(env, t, []);
      return j({ ownerToken: t });
    }

    // Create or update your card.
    if (p === "/api/card" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const card = body && cleanCard(body.card);
      if (!card) return j({ error: "card with name required" }, 400);
      let owner = typeof body.ownerToken === "string" && body.ownerToken.length > 10 ? body.ownerToken : null;
      let slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!owner) { owner = token(); }
      if (!slug) { slug = rand(8); await env.KV.put("own/" + owner, slug); }
      const rec = { card, ownerToken: owner, slug, updatedAt: new Date().toISOString(), createdAt: (await getJSON(env.KV, "card/" + slug))?.createdAt || new Date().toISOString() };
      await env.KV.put("card/" + slug, JSON.stringify(rec));
      ctx.waitUntil(enrichGithub(env, slug, card));
      return j({ ownerToken: owner, slug });
    }

    // Public card fetch.
    const cm = p.match(/^\/api\/c\/([a-z0-9]+)$/);
    if (cm && req.method === "GET") {
      const rec = await getJSON(env.KV, "card/" + cm[1]);
      if (!rec) return j({ error: "not found" }, 404);
      const enriched = await getJSON(env.KV, "enrich/" + cm[1]);
      return j({ slug: rec.slug, card: rec.card, enriched: enriched || null, verified: await isVerified(env, rec.ownerToken) });
    }

    // Scanner met a card owner.
    if (p === "/api/meet" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.slug !== "string") return j({ error: "slug required" }, 400);
      const rec = await getJSON(env.KV, "card/" + body.slug);
      if (!rec) return j({ error: "card not found" }, 404);
      let scanner = typeof body.scannerToken === "string" && body.scannerToken.length > 10 ? body.scannerToken : null;
      if (!scanner) { scanner = token(); await env.KV.put("own/" + scanner, ""); }
      const now = new Date().toISOString();
      const loc = cleanLocation(body.location);
      const evt = (body.event || "").slice(0, 200);
      // scanner saves card owner
      const scannerPeople = await getPeople(env, scanner);
      const person = { id: "p_" + rand(10), slug: rec.slug, card: rec.card, metAt: now, event: evt, location: loc, note: "", enriched: (await getJSON(env.KV, "enrich/" + rec.slug)) || null };
      if (!scannerPeople.some(x => x.slug === rec.slug)) { scannerPeople.unshift(person); await putPeople(env, scanner, scannerPeople); }
      // mutual: card owner saves scanner's card back
      let mutual = false;
      const scannerSlug = await env.KV.get("own/" + scanner);
      if (scannerSlug) {
        const sRec = await getJSON(env.KV, "card/" + scannerSlug);
        if (sRec && rec.ownerToken) {
          const ownerPeople = await getPeople(env, rec.ownerToken);
          if (!ownerPeople.some(x => x.slug === scannerSlug)) {
            ownerPeople.unshift({ id: "p_" + rand(10), slug: scannerSlug, card: sRec.card, metAt: now, event: evt, location: loc, note: "", enriched: (await getJSON(env.KV, "enrich/" + scannerSlug)) || null });
            await putPeople(env, rec.ownerToken, ownerPeople);
          }
          mutual = true;
        }
      }
      return j({ scannerToken: scanner, card: rec.card, personId: person.id, mutualSaved: mutual });
    }

    // List your people.
    if (p === "/api/people" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      return j({ people: await getPeople(env, owner) });
    }

    // Update/delete a person (note).
    const pm = p.match(/^\/api\/people\/([a-z0-9_]+)$/);
    if (pm && (req.method === "PUT" || req.method === "DELETE")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const list = await getPeople(env, owner);
      const i = list.findIndex(x => x.id === pm[1]);
      if (i < 0) return j({ error: "not found" }, 404);
      if (req.method === "DELETE") { list.splice(i, 1); await putPeople(env, owner, list); return j({ ok: true }); }
      const body = await req.json().catch(() => ({}));
      if (typeof body.note === "string") list[i].note = body.note.slice(0, 2000);
      if (typeof body.event === "string") list[i].event = body.event.slice(0, 200);
      if (body.photo === "") { delete list[i].photo; }
      else if (typeof body.photo === "string" && body.photo.startsWith("data:image/")) list[i].photo = body.photo.slice(0, 420000);
      await putPeople(env, owner, list);
      return j({ ok: true, person: list[i] });
    }

    // Email + password sign-up (free, no email service: addresses are not verified, so no email-based recovery yet).
    if (p === "/api/auth/signup" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const email = normEmail(body && body.email);
      const pw = body && typeof body.password === "string" ? body.password : "";
      if (!EMAIL_RE.test(email)) return j({ error: "Enter a valid email address" }, 400);
      if (pw.length < 8 || pw.length > 200) return j({ error: "Password must be at least 8 characters" }, 400);
      const ip = req.headers.get("CF-Connecting-IP") || "x";
      if (await overLimit(env, "signup/" + ip, Number(env.SIGNUP_PER_HOUR) || 10, 3600)) return j({ error: "Too many sign-ups from here - try again later" }, 429);
      if ((await env.KV.get("auth/e/" + email)) !== null) return j({ error: "That email already has an account - sign in instead" }, 409);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await hashPassword(pw, salt, PBKDF2_ITER);
      const deviceTok = typeof body.deviceToken === "string" && body.deviceToken.length > 10 ? body.deviceToken : null;
      // The credential record points at an owner token, created below.
      const owner = await linkIdentity(env, "auth/e/" + email + "#link", deviceTok);
      // Recovery code: the only way back in if the password is forgotten, since we cannot verify email addresses.
      const recoveryCode = newRecoveryCode();
      const rsalt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const rhash = await hashPassword(recoveryCode, rsalt, PBKDF2_ITER);
      await env.KV.put("auth/e/" + email, JSON.stringify({ owner, salt, hash, iter: PBKDF2_ITER, rsalt, rhash, createdAt: new Date().toISOString() }));
      await env.KV.delete("auth/e/" + email + "#link");
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      await env.KV.put("prof/" + owner, JSON.stringify({ email, name, picture: "", sub: "email:" + email }));
      return j({ ownerToken: owner, profile: { email, name, picture: "", kind: "email", emailVerified: false }, recoveryCode });
    }
    // Password reset with the recovery code shown at sign-up. Rotates the code on success.
    if (p === "/api/auth/reset" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const email = normEmail(body && body.email);
      const code = body && typeof body.recoveryCode === "string" ? body.recoveryCode.trim().toLowerCase() : "";
      const pw = body && typeof body.newPassword === "string" ? body.newPassword : "";
      if (pw.length < 8 || pw.length > 200) return j({ error: "New password must be at least 8 characters" }, 400);
      if (await overLimit(env, "reset/" + email, 5, 3600)) return j({ error: "Too many attempts - try again in an hour" }, 429);
      const rec = await getJSON(env.KV, "auth/e/" + email);
      const h = await hashPassword(code, rec && rec.rsalt ? rec.rsalt : b64(new Uint8Array(16)), PBKDF2_ITER);
      if (!rec || !rec.rhash || !safeEqual(h, rec.rhash)) return j({ error: "Email or recovery code is wrong" }, 401);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      rec.salt = salt; rec.iter = PBKDF2_ITER; rec.hash = await hashPassword(pw, salt, PBKDF2_ITER);
      const recoveryCode = newRecoveryCode();
      rec.rsalt = b64(crypto.getRandomValues(new Uint8Array(16))); rec.rhash = await hashPassword(recoveryCode, rec.rsalt, PBKDF2_ITER);
      await env.KV.put("auth/e/" + email, JSON.stringify(rec));
      const prof = await getJSON(env.KV, "prof/" + rec.owner);
      return j({ ownerToken: rec.owner, profile: { email, name: (prof && prof.name) || "", picture: "", kind: "email", emailVerified: !!(prof && prof.emailVerified) }, recoveryCode });
    }
    if (p === "/api/auth/login" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const email = normEmail(body && body.email);
      const pw = body && typeof body.password === "string" ? body.password : "";
      if (!email || !pw) return j({ error: "Email and password required" }, 400);
      if (await overLimit(env, "login/" + email, 8, 900)) return j({ error: "Too many attempts - wait 15 minutes and try again" }, 429);
      const rec = await getJSON(env.KV, "auth/e/" + email);
      // Always run the hash so unknown emails and wrong passwords take the same time.
      const salt = rec ? rec.salt : b64(new Uint8Array(16));
      const h = await hashPassword(pw, salt, rec ? rec.iter : PBKDF2_ITER);
      if (!rec || !safeEqual(h, rec.hash)) return j({ error: "Email or password is wrong" }, 401);
      const deviceTok = typeof body.deviceToken === "string" && body.deviceToken.length > 10 ? body.deviceToken : null;
      let owner = rec.owner;
      if (deviceTok && deviceTok !== owner && (await env.KV.get("own/" + deviceTok)) !== null) {
        await env.KV.put("auth/e/" + email + "#link", owner);
        owner = await linkIdentity(env, "auth/e/" + email + "#link", deviceTok);
        await env.KV.delete("auth/e/" + email + "#link");
      }
      const prof = await getJSON(env.KV, "prof/" + owner);
      return j({ ownerToken: owner, profile: { email, name: (prof && prof.name) || "", picture: "", kind: "email", emailVerified: !!(prof && prof.emailVerified) } });
    }

    if (p === "/api/mail/webhook" && req.method === "POST") {
      const raw = await req.text();
      if (!(await verifyWebhook(env, req, raw))) return j({ error: "bad signature" }, 401);
      let ev = null; try { ev = JSON.parse(raw); } catch (e) {}
      const to = ev && ev.data && Array.isArray(ev.data.to) ? ev.data.to : [];
      if (ev && (ev.type === "email.bounced" || ev.type === "email.complained")) for (const a of to) await env.KV.put("suppress/" + normEmail(a), ev.type);
      return j({ ok: true });
    }
    // Delete account: removes this person's own data. Needs the owner token, the word DELETE, and for email accounts the password.
    // Does NOT touch cards other people saved of you (their own records), or Cloudflare's short-lived backups/caches.
    if (p === "/api/account" && req.method === "DELETE") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      if (!body || body.confirm !== "DELETE") return j({ error: "Type DELETE to confirm" }, 400);
      const prof = await getJSON(env.KV, "prof/" + owner);
      const keys = [];
      if (prof && String(prof.sub || "").startsWith("email:")) {
        if (await overLimit(env, "login/" + prof.email, 8, 900)) return j({ error: "Too many attempts - wait 15 minutes and try again" }, 429);
        const rec = await getJSON(env.KV, "auth/e/" + prof.email);
        const pw = typeof body.password === "string" ? body.password : "";
        const h = await hashPassword(pw, rec ? rec.salt : b64(new Uint8Array(16)), rec ? rec.iter : PBKDF2_ITER);
        if (!rec || rec.owner !== owner || !safeEqual(h, rec.hash)) return j({ error: "Password is wrong" }, 401);
        keys.push("auth/e/" + prof.email);
      } else if (prof && prof.sub) {
        // Google accounts must sign in with Google again right now, and it must be the same Google account.
        const idt = await verifyGoogle(env, body.credential);
        if (!idt) return j({ error: "Sign in with Google again to confirm" }, 401);
        if (String(idt.sub) !== String(prof.sub)) return j({ error: "That is a different Google account" }, 401);
        keys.push("auth/g/" + prof.sub);
      }
      const slug = await env.KV.get("own/" + owner);
      const inbox = (await getJSON(env.KV, "cin/" + owner)) || [];
      for (const x of inbox) if (x && x.id) keys.push("crt/" + x.id);
      if (slug) keys.push("card/" + slug, "enrich/" + slug);
      for (const t of ((await getJSON(env.KV, "mcpl/" + owner)) || [])) keys.push("mcp/" + t.h);
      keys.push("mcpl/" + owner, "ppl/" + owner, "prof/" + owner, "cin/" + owner, "vcode/" + owner, "scn/" + owner, "own/" + owner);
      for (const k of keys) await env.KV.delete(k);
      return j({ deleted: true });
    }


    // ---- Agent access tokens (owner-managed) and the read-only MCP endpoint (token-only).
    if (p === "/api/tokens" && (req.method === "GET" || req.method === "POST")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const list = (await getJSON(env.KV, "mcpl/" + owner)) || [];
      const live = list.filter(t => t.exp > Date.now());
      if (req.method === "GET") return j({ tokens: live.map(t => ({ id: t.id, name: t.name, scope: t.scope, created: t.created, expires: t.exp, lastUsed: t.lastUsed || null })) });
      const body = await req.json().catch(() => null);
      const name = body && typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      const scope = body && body.scope;
      if (!name) return j({ error: "Name the agent this is for" }, 400);
      if (!MCP_SCOPES.includes(scope)) return j({ error: "Pick what the agent may read" }, 400);
      if (live.length >= 5) return j({ error: "You can have 5 agent connections. Remove one first." }, 400);
      if (await overLimit(env, "mcptok/" + owner, 10, 3600)) return j({ error: "Too many new connections - try again later" }, 429);
      const tok = "tgm_" + token() + token();
      const h = await sha256hex(tok);
      const id = rand(10), now = Date.now();
      await env.KV.put("mcp/" + h, JSON.stringify({ owner, id, scope, exp: now + MCP_TTL_MS }), { expirationTtl: Math.floor(MCP_TTL_MS / 1000) + 3600 });
      live.push({ id, name, scope, created: now, exp: now + MCP_TTL_MS, h });
      await env.KV.put("mcpl/" + owner, JSON.stringify(live));
      return j({ token: tok, id, name, scope, expires: now + MCP_TTL_MS });
    }
    const tm = p.match(/^\/api\/tokens\/([a-z0-9]+)$/);
    if (tm && req.method === "DELETE") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const list = (await getJSON(env.KV, "mcpl/" + owner)) || [];
      const t = list.find(q => q.id === tm[1]);
      if (!t) return j({ error: "not found" }, 404);
      await env.KV.delete("mcp/" + t.h);
      await env.KV.put("mcpl/" + owner, JSON.stringify(list.filter(q => q.id !== tm[1])));
      return j({ revoked: true });
    }
    if (p === "/api/mcp") {
      if (req.method !== "POST") return j({ error: "POST JSON-RPC only" }, 405);
      const h = req.headers.get("Authorization") || "";
      const tok = h.startsWith("Bearer tgm_") ? h.slice(7) : "";
      const rec = tok && tok.length < 200 ? await getJSON(env.KV, "mcp/" + (await sha256hex(tok))) : null;
      if (!rec || rec.exp < Date.now() || (await env.KV.get("own/" + rec.owner)) === null) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...CORS } });
      if (await overLimit(env, "mcp/" + rec.id, 120, 3600)) return j({ error: "rate limited" }, 429);
      const m = await req.json().catch(() => null);
      if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return j({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
      const reply = (result) => j({ jsonrpc: "2.0", id: m.id, result });
      const fail = (code, message) => j({ jsonrpc: "2.0", id: m.id, error: { code, message } });
      if (m.id === undefined) return new Response(null, { status: 202, headers: CORS });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "tagg", version: "1" }, instructions: "Read-only access to the people this Tagg user has met. Identity and imported details are as entered by people and are not verified by Tagg." });
      if (m.method === "ping") return reply({});
      if (m.method === "tools/list") return reply({ tools: MCP_TOOLS });
      if (m.method === "tools/call") {
        const out = await mcpCall(env, rec.owner, rec.scope, m.params && m.params.name, (m.params && m.params.arguments) || {});
        if (out === null) return fail(-32602, "Unknown tool");
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }] });
      }
      return fail(-32601, "Method not found");
    }

    // Anonymous scan ping: someone opened this card's link. Tells the owner "someone scanned" with NO identity (no name,
    // no IP stored). Rate limited, short lived. Identity only ever arrives later, if the scanner chooses to share.
    if (p === "/api/scan" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const slug = body && typeof body.slug === "string" ? body.slug : "";
      if (!/^[a-z0-9]{6,10}$/.test(slug)) return j({ error: "bad slug" }, 400);
      const ip = req.headers.get("CF-Connecting-IP") || "x";
      if (await overLimit(env, "scan/" + slug + "/" + ip, 3, 60)) return j({ ok: true, throttled: true });
      if (await overLimit(env, "scanslug/" + slug, 40, 3600)) return j({ ok: true, throttled: true });
      const rec = await getJSON(env.KV, "card/" + slug);
      if (!rec || !rec.ownerToken) return j({ error: "not found" }, 404);
      const list = ((await getJSON(env.KV, "scn/" + rec.ownerToken)) || []).filter(x => Date.now() - Date.parse(x.at) < 900000);
      list.unshift({ id: "s_" + rand(8), at: new Date().toISOString() });
      await env.KV.put("scn/" + rec.ownerToken, JSON.stringify(list.slice(0, 20)), { expirationTtl: 3600 });
      return j({ ok: true });
    }
    // Save someone privately: adds their public card to MY people with my context. Nothing is sent to them.
    if (p === "/api/people" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      const slug = body && typeof body.slug === "string" ? body.slug : "";
      const rec = /^[a-z0-9]{6,10}$/.test(slug) ? await getJSON(env.KV, "card/" + slug) : null;
      if (!rec) return j({ error: "That card was not found" }, 404);
      if (rec.ownerToken === owner) return j({ error: "That is your own card" }, 400);
      const list = await getPeople(env, owner);
      let person = list.find(x => x.slug === slug);
      if (!person) {
        person = { id: "p_" + rand(10), slug, card: rec.card, metAt: new Date().toISOString(),
          event: typeof body.event === "string" ? body.event.slice(0, 200) : "", location: cleanLocation(body.location),
          note: typeof body.note === "string" ? body.note.slice(0, 2000) : "", enriched: (await getJSON(env.KV, "enrich/" + slug)) || null, savedPrivately: true };
        list.unshift(person);
        await putPeople(env, owner, list);
      }
      return j({ person });
    }

    // Email verification: request a 6-digit code (valid 15 min), then confirm it. Only for email/password accounts.
    if (p === "/api/auth/email/request" && req.method === "POST") {
      const owner = authOwner(req);
      const prof = owner ? await getJSON(env.KV, "prof/" + owner) : null;
      if (!prof) return j({ error: "Sign in first" }, 401);
      if (!String(prof.sub || "").startsWith("email:")) return j({ error: "This account is already verified by Google" }, 400);
      if (prof.emailVerified === true) return j({ verified: true });
      if (!mailEnabled(env)) return j({ error: "Email verification is not switched on yet" }, 503);
      if ((await env.KV.get("suppress/" + prof.email)) !== null) return j({ error: "That address cannot receive our email" }, 400);
      if (await overLimit(env, "vreq/" + owner, 3, 3600)) return j({ error: "Too many codes requested - try again in an hour" }, 429);
      if (!(await mailBudgetOk(env, prof.email))) return j({ error: "Email is busy right now - try again tomorrow" }, 429);
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      await env.KV.put("vcode/" + owner, JSON.stringify({ h: await codeHash(owner, code), email: prof.email }), { expirationTtl: 900 });
      try { await sendMail(env, prof.email, "Confirm your Tagg email", "Your Tagg code is " + code + ". It expires in 15 minutes.\nIf you did not create a Tagg account, ignore this email."); }
      catch (e) { await env.KV.delete("vcode/" + owner); return j({ error: "Could not send the email - try again later" }, 502); }
      return j({ sent: true });
    }
    if (p === "/api/auth/email/confirm" && req.method === "POST") {
      const owner = authOwner(req);
      const prof = owner ? await getJSON(env.KV, "prof/" + owner) : null;
      if (!prof) return j({ error: "Sign in first" }, 401);
      const body = await req.json().catch(() => null);
      const code = body && typeof body.code === "string" ? body.code.trim() : "";
      if (await overLimit(env, "vconf/" + owner, 5, 900)) return j({ error: "Too many wrong codes - request a new one in 15 minutes" }, 429);
      const rec = await getJSON(env.KV, "vcode/" + owner);
      if (!rec || rec.email !== prof.email || !/^\d{6}$/.test(code) || !safeEqual(await codeHash(owner, code), rec.h)) return j({ error: "That code is wrong or has expired" }, 400);
      prof.emailVerified = true;
      await env.KV.put("prof/" + owner, JSON.stringify(prof));
      await env.KV.delete("vcode/" + owner);
      return j({ verified: true });
    }

    // Google OAuth sign-in: verify id_token, link identity to an owner token, merge device data.
    if (p === "/api/auth/google" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.credential !== "string") return j({ error: "credential required" }, 400);
      const vr = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(body.credential));
      if (!vr.ok) return j({ error: "Google token rejected" }, 401);
      const idt = await vr.json();
      if (idt.aud !== env.GOOGLE_CLIENT_ID) return j({ error: "wrong audience" }, 401);
      if (idt.email_verified !== "true" && idt.email_verified !== true) return j({ error: "email not verified" }, 401);
      const sub = String(idt.sub);
      const deviceTok = typeof body.deviceToken === "string" && body.deviceToken.length > 10 ? body.deviceToken : null;
      const linked = await linkIdentity(env, "auth/g/" + sub, deviceTok);
      await env.KV.put("prof/" + linked, JSON.stringify({ email: idt.email, name: idt.name || "", picture: idt.picture || "", sub }));
      return j({ ownerToken: linked, profile: { email: idt.email, name: idt.name || "", picture: idt.picture || "" } });
    }

    // Who am I.
    if (p === "/api/me" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const prof = await getJSON(env.KV, "prof/" + owner);
      return j({ profile: prof ? { email: prof.email, name: prof.name, picture: prof.picture } : null, slug: (await env.KV.get("own/" + owner)) || null });
    }

    // Apple Wallet pass for your own card, via the free external signer (same path as Pocket Note).
    if (p === "/api/pass" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const slug = await env.KV.get("own/" + owner);
      if (!slug) return j({ error: "make your card first" }, 400);
      const rec = await getJSON(env.KV, "card/" + slug);
      if (!rec) return j({ error: "make your card first" }, 400);
      const cardUrl = "https://robox2020.github.io/tagg/#/c/" + slug;
      const back = [];
      if (rec.card.headline) back.push({ key: "headline", label: "HEADLINE", value: rec.card.headline });
      for (const k of ["linkedin", "github", "x", "instagram", "website"]) { if (rec.card.links && rec.card.links[k]) back.push({ key: k, label: k.toUpperCase(), value: rec.card.links[k] }); }
      if (rec.card.email) back.push({ key: "email", label: "EMAIL", value: rec.card.email });
      back.push({ key: "open", label: "OPEN MY CARD", value: cardUrl });
      try {
        const r = await fetch("https://walletmcppass.com/api/passes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          style: "generic", organization_name: "Tagg", description: "Tagg card - scan to connect",
          logo_text: rec.card.name.slice(0, 40),
          primary_fields: [{ key: "name", label: "TAGG CARD", value: rec.card.name.slice(0, 60) }],
          secondary_fields: rec.card.headline ? [{ key: "hl", label: "", value: rec.card.headline.slice(0, 80) }] : [],
          back_fields: back.slice(0, 8),
          barcode_message: cardUrl, barcode_format: "QR",
          background_color: "#1c1c1e", foreground_color: "#f5f5f7", label_color: "#ff7a1a", icon_text: "T"
        }) });
        if (!r.ok) return j({ error: r.status === 402 || r.status === 429 ? "Free Wallet signing quota is used up right now - your QR in the app does the same job." : "The free Wallet signer is unavailable - your QR in the app does the same job." }, 503);
        const a = await r.json();
        if (typeof a.download_url !== "string" || !a.download_url.startsWith("https://walletmcppass.com/download/")) return j({ error: "Unexpected signer response" }, 502);
        return j({ download_url: a.download_url });
      } catch (e) { return j({ error: "Could not reach the Wallet signer - your QR in the app does the same job." }, 503); }
    }

    // Scanner asks to connect with a card owner (consent flow: owner gets notified, both save the moment).
    if (p === "/api/connect" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.slug !== "string") return j({ error: "slug required" }, 400);
      const rec = await getJSON(env.KV, "card/" + body.slug);
      if (!rec) return j({ error: "card not found" }, 404);
      if (!rec.ownerToken) return j({ error: "this card cannot take requests" }, 400);
      let rt = typeof body.requesterToken === "string" && body.requesterToken.length > 10 ? body.requesterToken : null;
      if (!rt) { rt = token(); await env.KV.put("own/" + rt, ""); await putPeople(env, rt, []); }
      else if ((await env.KV.get("own/" + rt)) === null) return j({ error: "unknown requester" }, 401);
      if (rt === rec.ownerToken) return j({ error: "that is your own card" }, 400);
      const reqSlug = await env.KV.get("own/" + rt);
      if (reqSlug && reqSlug === body.slug) return j({ error: "that is your own card" }, 400);
      const name = (body.name || "").slice(0, 120).trim();
      const contact = (body.contact || "").slice(0, 200).trim();
      if (!reqSlug && !name) return j({ error: "name required" }, 400);
      const inbox = (await getJSON(env.KV, "cin/" + rec.ownerToken)) || [];
      const dup = inbox.find(x => x.requesterToken === rt && x.status === "pending");
      if (dup) return j({ requestId: dup.id, requestToken: rt, status: "pending", duplicate: true });
      const id = "r_" + rand(10);
      const loc = cleanLocation(body.location);
      inbox.unshift({ id, name, contact, requesterToken: rt, requesterSlug: reqSlug || null,
        event: (body.event || "").slice(0, 200), location: loc, at: new Date().toISOString(), status: "pending",
        // Private to the requester: copied only into the requester's own saved person, never returned by /api/inbox.
        requesterNote: typeof body.note === "string" ? body.note.slice(0, 2000) : "" });
      await env.KV.put("cin/" + rec.ownerToken, JSON.stringify(inbox.slice(0, 50)));
      await env.KV.put("crt/" + id, JSON.stringify({ owner: rec.ownerToken, id }));
      return j({ requestId: id, requestToken: rt, status: "pending" });
    }

    // Scanner polls the fate of their connect request.
    if (p === "/api/connect/status" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const ptr = await getJSON(env.KV, "crt/" + id);
      if (!ptr) return j({ error: "not found" }, 404);
      const inbox = (await getJSON(env.KV, "cin/" + ptr.owner)) || [];
      const rq = inbox.find(x => x.id === ptr.id);
      if (!rq) return j({ error: "not found" }, 404);
      const out = { status: rq.status };
      if (rq.status === "accepted") {
        const slug = await env.KV.get("own/" + ptr.owner);
        const rec = slug ? await getJSON(env.KV, "card/" + slug) : null;
        out.card = rec ? rec.card : null;
        out.personId = rq.requesterPersonId || null;
      }
      return j(out);
    }

    // Owner's connection-request inbox.
    if (p === "/api/inbox" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const inbox = (await getJSON(env.KV, "cin/" + owner)) || [];
      const pend = inbox.filter(x => x.status === "pending");
      const out = [];
      for (const x of pend) out.push({ id: x.id, name: x.name, contact: x.contact, event: x.event, location: x.location, at: x.at, hasCard: !!x.requesterSlug, verified: await isVerified(env, x.requesterToken) });
      const scans = ((await getJSON(env.KV, "scn/" + owner)) || []).filter(x => Date.now() - Date.parse(x.at) < 900000).map(x => ({ id: x.id, at: x.at }));
      return j({ requests: out, scans });
    }

    // Owner accepts or declines; accept saves the connection both ways.
    if (p === "/api/inbox/respond" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      if (!body || typeof body.id !== "string") return j({ error: "id required" }, 400);
      const inbox = (await getJSON(env.KV, "cin/" + owner)) || [];
      const rq = inbox.find(x => x.id === body.id);
      if (!rq) return j({ error: "not found" }, 404);
      if (rq.status !== "pending") return j({ error: "already handled" }, 400);
      if (!body.accept) {
        rq.status = "declined";
        await env.KV.put("cin/" + owner, JSON.stringify(inbox));
        return j({ ok: true, status: "declined" });
      }
      const now = new Date().toISOString();
      let rCard = null;
      if (rq.requesterSlug) { const rr = await getJSON(env.KV, "card/" + rq.requesterSlug); if (rr) rCard = rr.card; }
      if (!rCard) {
        rCard = { name: rq.name || "New connection", headline: "", email: /@/.test(rq.contact || "") ? rq.contact : "", phone: "", links: {} };
        if (!rCard.email && rq.contact) { if (/^[+0-9][0-9 ()-]{5,}$/.test(rq.contact)) rCard.phone = rq.contact; else rCard.headline = rq.contact; }
      }
      const ownerPeople = await getPeople(env, owner);
      let op = ownerPeople.find(x => (rq.requesterSlug && x.slug === rq.requesterSlug) || (!rq.requesterSlug && x.card.name.toLowerCase() === rCard.name.toLowerCase()));
      if (!op) {
        op = { id: "p_" + rand(10), slug: rq.requesterSlug || null, card: rCard, metAt: rq.at || now,
          event: rq.event || "", location: rq.location || null, note: "",
          enriched: rq.requesterSlug ? (await getJSON(env.KV, "enrich/" + rq.requesterSlug)) || null : null };
        ownerPeople.unshift(op);
        await putPeople(env, owner, ownerPeople);
      }
      let requesterPersonId = null;
      if (rq.requesterToken && (await env.KV.get("own/" + rq.requesterToken)) !== null) {
        const mySlug = await env.KV.get("own/" + owner);
        const myRec = mySlug ? await getJSON(env.KV, "card/" + mySlug) : null;
        if (myRec) {
          const rPeople = await getPeople(env, rq.requesterToken);
          let rp = rPeople.find(x => x.slug === mySlug);
          if (!rp) {
            rp = { id: "p_" + rand(10), slug: mySlug, card: myRec.card, metAt: rq.at || now,
              event: rq.event || "", location: rq.location || null, note: rq.requesterNote || "",
              enriched: (await getJSON(env.KV, "enrich/" + mySlug)) || null };
            rPeople.unshift(rp);
            await putPeople(env, rq.requesterToken, rPeople);
          }
          requesterPersonId = rp.id;
        }
      }
      rq.status = "accepted"; rq.ownerPersonId = op.id; rq.requesterPersonId = requesterPersonId;
      await env.KV.put("cin/" + owner, JSON.stringify(inbox));
      return j({ ok: true, status: "accepted", personId: op.id });
    }

    // LinkedIn import, step 1: read the public page of the URL the owner typed and return a PREVIEW. Nothing is saved yet.
    if (p === "/api/import/linkedin" && req.method === "POST") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      const urlIn = body && typeof body.url === "string" && body.url.trim() ? body.url : "";
      const url = urlIn ? parseLinkedinUrl(urlIn) : null;
      if (urlIn && !url) return j({ error: "Paste a link like linkedin.com/in/yourname" }, 400);
      const text = body && typeof body.text === "string" ? body.text.trim().slice(0, 12000) : "";
      let data = null, source = "linkedin-pasted-text";
      if (!text && url) {
        if (body.ownProfile !== true) return j({ error: "Confirm that this is your own profile" }, 400);
        if (env.APIFY_ENABLED !== "1" || !env.APIFY_TOKEN) return j({ error: "Import from a link is unavailable right now. You can paste your profile text instead." }, 503);
        if (await overLimit(env, "liimport/" + owner, 6, 3600)) return j({ error: "Too many imports - try again in an hour" }, 429);
        if (await overLimit(env, "liapify/owner/" + owner, 3, 86400)) return j({ error: "You have used today's link imports. Paste your profile text instead." }, 429);
        if (await overLimit(env, "liapify/day/" + new Date().toISOString().slice(0, 10), Number(env.APIFY_DAILY_CAP) || 40, 86400)) return j({ error: "Link import is busy today. Paste your profile text instead." }, 429);
        let res = null; try { res = await importViaApify(env, url); } catch (e) { res = { unavailable: "network" }; }
        if (res && res.unavailable !== undefined) return j({ error: "Could not read that profile right now. Paste your profile text instead.", reason: res.unavailable }, 503);
        if (!res) return j({ error: "Could not read that profile. Is it public? You can paste your profile text instead." }, 422);
        data = res; source = "linkedin-link-import";
      } else {
        if (text.length < 40) return j({ error: "Paste the text of your LinkedIn profile first" }, 400);
        if (!env.AI) return j({ error: "Import is unavailable right now" }, 503);
        if (await overLimit(env, "liimport/" + owner, 6, 3600)) return j({ error: "Too many imports - try again in an hour" }, 429);
        data = await extractProfile(env, text);
        if (data && data.unavailable !== undefined) return j({ error: "Import is busy right now - try again in a minute", reason: data.unavailable }, 503);
        if (!data) return j({ error: "Could not find a role, employer or school in that text. Paste the Experience and Education sections, or type them on your card." }, 422);
      }
      const res = { data };
      const previewId = rand(16);
      await env.KV.put("liprev/" + previewId, JSON.stringify({ owner, url: url || "", data: res.data, source, at: new Date().toISOString() }), { expirationTtl: 900 });
      return j({ previewId, url, fields: res.data, source: source === "linkedin-link-import" ? "Your public LinkedIn profile" : "Text you pasted from LinkedIn" });
    }
    // Step 2: the owner reviews/edits the fields, then confirms. Only then is anything stored, with its provenance.
    if (p === "/api/import/linkedin/confirm" && req.method === "POST") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      const prev = body && typeof body.previewId === "string" ? await getJSON(env.KV, "liprev/" + body.previewId) : null;
      if (!prev || prev.owner !== owner) return j({ error: "That import expired - start again" }, 410);
      const f = (body && body.fields) || {};
      const list = (x, n) => asNames(Array.isArray(x) ? x.filter(v => typeof v === "string") : [], n);
      const fields = { headline: clip(f.headline, 300), titles: list(f.titles, 5), companies: list(f.companies, 6), schools: list(f.schools, 6), location: clip(f.location, 120) };
      const existing = (await getJSON(env.KV, "enrich/" + slug)) || {};
      existing.linkedin = Object.assign(fields, { source: prev.source || "linkedin-pasted-text", url: prev.url, importedAt: prev.at, confirmedAt: new Date().toISOString(),
        company: fields.companies[0] || null, title: fields.titles[0] || null, school: fields.schools[0] || null });
      await env.KV.put("enrich/" + slug, JSON.stringify(existing));
      await env.KV.delete("liprev/" + body.previewId);
      return j({ ok: true, linkedin: existing.linkedin });
    }
    if (p === "/api/import/linkedin" && req.method === "DELETE") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const existing = (await getJSON(env.KV, "enrich/" + slug)) || {};
      delete existing.linkedin;
      await env.KV.put("enrich/" + slug, JSON.stringify(existing));
      return j({ ok: true });
    }

    // Ask Tagg: answer questions from your saved people via Cloudflare Workers AI (free plan; no paid fallback).
    if (p === "/api/ask" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      if (!env.AI) return j({ error: "ask unavailable" }, 503);
      const body = await req.json().catch(() => null);
      const q = ((body && body.q) || "").slice(0, 500).trim();
      if (!q) return j({ error: "question required" }, 400);
      const people = (await getPeople(env, owner)).slice(0, 60).map(x => ({
        name: x.card.name, headline: x.card.headline || null, links: Object.keys(x.card.links || {}),
        event: x.event || null, metAt: x.metAt, where: (x.location && x.location.label) || null,
        note: x.note || null,
        about: x.enriched && x.enriched.linkedin ? [x.enriched.linkedin.headline, "roles: " + (x.enriched.linkedin.titles || []).join(", "), "worked at: " + (x.enriched.linkedin.companies || [x.enriched.linkedin.company]).filter(Boolean).join(", "), "studied at: " + (x.enriched.linkedin.schools || [x.enriched.linkedin.school]).filter(Boolean).join(", "), x.enriched.linkedin.location].filter(v => v && !/: $/.test(v)).join("; ")
          : x.enriched && x.enriched.github ? [x.enriched.github.bio, x.enriched.github.company].filter(Boolean).join("; ") : null
      }));
      const hist = (body && Array.isArray(body.history) ? body.history : []).slice(-6).filter(h => h && (h.r === "me" || h.r === "tagg") && typeof h.t === "string").map(h => (h.r === "me" ? "USER: " : "TAGG: ") + h.t.slice(0, 500)).join("\n");
      const prompt = "You are Tagg, a personal people-memory assistant. Answer the user's question using ONLY the JSON list of people they have met (each has name, headline, event, when and where they met, a private note, and a public-profile about). If nobody matches, say so plainly and suggest what to try. When people match, name them and say when and where the user met them, plus anything useful from notes or about. Concise (under 120 words), warm, plain text, no markdown, no bullets unless listing several people.\n\nPEOPLE JSON:\n" + JSON.stringify(people) + (hist ? "\n\nEARLIER IN THIS CONVERSATION (use it to resolve words like she, he, they, that person, and who else):\n" + hist : "") + "\n\nQUESTION: " + q;
      let answer = null, lastStatus = 0;
      if (await overLimit(env, "ask/" + owner, 60, 3600)) return j({ error: "Too many questions - try again in a while" }, 429);
      if (env.AI) {
        for (const m of AI_MODELS) {
          try {
            const r = await env.AI.run(m, { messages: [{ role: "user", content: prompt }], max_tokens: 700, temperature: 0.2 });
            const txt = typeof r.response === "string" ? r.response : "";
            if (txt.trim()) { answer = txt.trim(); break; }
          } catch (e) { lastStatus = 1; }
        }
      }
      if (!answer) return j({ error: "ask_failed", upstream: lastStatus }, 502);
      return j({ answer });
    }

    // One-time migration of legacy on-device people.
    if (p === "/api/migrate" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.ownerToken !== "string" || body.ownerToken.length < 10) return j({ error: "ownerToken required" }, 400);
      if ((await env.KV.get("own/" + body.ownerToken)) === null) return j({ error: "unauthorized" }, 401);
      const incoming = Array.isArray(body.people) ? body.people : [];
      const list = await getPeople(env, body.ownerToken);
      for (const x of incoming.slice(0, 200)) {
        const card = cleanCard(x.card); if (!card) continue;
        // Skip people the server already has (a device that synced them from here must not upload them again).
        const metAtIn = typeof x.metAt === "string" ? x.metAt : "";
        if (list.some(q => (typeof x.id === "string" && q.id === x.id) || (q.card.name === card.name && metAtIn && q.metAt === metAtIn))) continue;
        let loc = null;
        if (x.location && typeof x.location === "object") loc = { lat: x.location.lat ?? null, lon: x.location.lon ?? null, label: (x.location.label || "").slice(0, 200) };
        else if (x.place && typeof x.place === "object") loc = { lat: x.place.lat ?? null, lon: x.place.lng ?? null, label: "" };
        list.push({ id: "p_" + rand(10), slug: null, card,
          metAt: typeof x.metAt === "string" ? x.metAt : new Date().toISOString(),
          event: (x.event || "").slice(0, 200), location: loc, note: (x.note || "").slice(0, 2000), enriched: null });
      }
      await putPeople(env, body.ownerToken, list);
      return j({ ok: true, count: list.length });
    }

    // Graph export: nodes + met edges.
    if (p === "/api/graph" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const people = await getPeople(env, owner);
      const nodes = [{ id: "me", type: "self", name: "You" }];
      const edges = [];
      for (const x of people) { nodes.push({ id: x.id, type: "person", name: x.card.name, slug: x.slug || null }); edges.push({ from: "me", to: x.id, kind: "met", at: x.metAt, event: x.event || null }); }
      return j({ nodes, edges });
    }

    return j({ error: "not found" }, 404);
  },
};
