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
async function getMany(kv, keys) { return kv.getMany ? kv.getMany(keys) : Promise.all(keys.map(k => kv.get(k))); }
// Atomic list insert. On the Durable Object store this is one indivisible step; on plain KV it falls back to read-modify-write (which can lose concurrent inserts).
async function jpush(kv, key, item, opts = {}) {
  if (kv.jpush) return kv.jpush(key, item, opts);
  const arr = (await getJSON(kv, key)) || [], dup = opts.dedupe ? arr.find(x => x && Object.entries(opts.dedupe).every(([f, v]) => x[f] === v)) : null;
  if (dup) return { dup };
  arr.unshift(item); await kv.put(key, JSON.stringify(arr.slice(0, opts.cap || 50))); return { added: true };
}
async function jpatch(kv, key, match, patch) {
  if (kv.jpatch) return kv.jpatch(key, match, patch);
  const arr = (await getJSON(kv, key)) || []; let n = 0;
  for (const x of arr) if (x && Object.entries(match).every(([f, v]) => x[f] === v)) { Object.assign(x, patch); n++; }
  if (n) await kv.put(key, JSON.stringify(arr)); return { patched: n };
}
// Enrich records hold independent sections (linkedin, github, ...). Load keeps a hidden snapshot; save writes only the top-level fields this request changed
// (atomic merge on the Durable Object store), so two imports finishing together no longer overwrite each other's section. On plain KV it falls back to a full write.
async function loadEnrich(kv, slug) { const raw = await kv.get("enrich/" + slug); const o = raw ? JSON.parse(raw) : {}; Object.defineProperty(o, "__orig", { value: raw ? JSON.parse(raw) : {}, enumerable: false }); return o; }
async function saveEnrich(kv, slug, o) {
  const orig = o.__orig || {}, set = {}, del = [];
  for (const k of Object.keys(o)) if (JSON.stringify(o[k]) !== JSON.stringify(orig[k])) set[k] = o[k];
  for (const k of Object.keys(orig)) if (!(k in o)) del.push(k);
  if (!Object.keys(set).length && !del.length) return;
  if (kv.jmerge) return kv.jmerge("enrich/" + slug, set, del);
  const cur = (await getJSON(kv, "enrich/" + slug)) || {}; Object.assign(cur, set); for (const k of del) delete cur[k]; await kv.put("enrich/" + slug, JSON.stringify(cur));
}
async function jappend(kv, key, items, cap) {
  if (kv.jappend) return kv.jappend(key, items, cap);
  const arr = (await getJSON(kv, key)) || []; let n = 0;
  for (const it of items) { if (arr.some(q => q && q.card && it.card && q.card.name === it.card.name && it.metAt && q.metAt === it.metAt)) continue; arr.push(it); n++; }
  await kv.put(key, JSON.stringify(arr.slice(0, cap))); return { added: n, total: Math.min(arr.length, cap) };
}
async function jdel(kv, key, match) {
  if (kv.jdel) return kv.jdel(key, match);
  const arr = (await getJSON(kv, key)) || [], keep = arr.filter(x => !(x && Object.entries(match).every(([f, v]) => x[f] === v)));
  if (keep.length !== arr.length) await kv.put(key, JSON.stringify(keep)); return { removed: arr.length - keep.length };
}
async function getJSON(kv, key) { const v = await kv.get(key); return v ? JSON.parse(v) : null; }
function cleanCard(c) {
  if (!c || typeof c.name !== "string" || !c.name.trim()) return null;
  const links = {}; if (c.links && typeof c.links === "object") for (const k of ["linkedin","github","x","instagram","website"]) { if (typeof c.links[k] === "string" && c.links[k]) links[k] = c.links[k].slice(0, 300); }
  return {
    name: c.name.slice(0, 120), headline: (c.headline || "").slice(0, 200), detail: (typeof c.detail === "string" ? c.detail : "").trim().slice(0, 160),
    email: (c.email || "").slice(0, 200), phone: (c.phone || "").slice(0, 40), links,
  };
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
// signed-in owner types their own LinkedIn URL and confirms it is their own profile. Hard per-run charge cap and a per-owner hourly abuse limit. No discretionary daily usage caps (owner decision); the account's own monthly hard limit and no card on file are the spend stop.
async function importViaApify(env, url) {
  // Kill switch: while KV key cfg/apify-paused exists, no request goes to Apify (manual paste still works).
  if ((await env.KV.get("cfg/apify-paused")) !== null) return { unavailable: "paused" };
  const r = await fetch("https://api.apify.com/v2/acts/harvestapi~linkedin-profile-scraper/run-sync-get-dataset-items?maxTotalChargeUsd=0.01&timeout=60", {
    method: "POST", headers: { "Authorization": "Bearer " + env.APIFY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ profileScraperMode: "Profile details no email ($4 per 1k)", queries: [url] }), signal: AbortSignal.timeout(70000) });
  if (!r.ok) return { unavailable: "apify " + r.status };
  const items = await r.json().catch(() => null);
  const x = Array.isArray(items) ? items[0] : null;
  if (!x || x.error || (!x.experience && !x.education && !x.headline)) return null;
  const uniq = (arr, n) => asNames(arr.filter(Boolean), n);
  const per = (o) => { const s = o && o.startDate && (o.startDate.text || o.startDate.year), e = o && o.endDate && (o.endDate.text || o.endDate.year); if (s) return clip(s + " - " + (e || "Present"), 60); const p = o && (o.period || o.dateRange || o.duration); return typeof p === "string" ? clip(p, 60) : ""; };
  const experience = (Array.isArray(x.experience) ? x.experience : []).filter(e => e && (e.position || e.companyName)).slice(0, 8).map(e => ({ title: clip(e.position, 120), company: clip(e.companyName, 120), period: per(e), place: clip(e.location, 80), text: clip(e.description, 400) }));
  const education = (Array.isArray(x.education) ? x.education : []).filter(e => e && e.schoolName).slice(0, 5).map(e => ({ school: clip(e.schoolName, 120), degree: clip([e.degree, e.fieldOfStudy].filter(Boolean).join(", "), 140), period: per(e) }));
  const skills = asNames((Array.isArray(x.skills) ? x.skills : []).map(s => typeof s === "string" ? s : s && s.name), 12);
  return {
    about: clip(x.about || x.summary, 1200), experience, education, skills,
    headline: clip(x.headline, 300),
    titles: uniq((x.experience || []).map(e => e && e.position), 5),
    companies: uniq((x.experience || []).map(e => e && e.companyName), 6),
    schools: uniq((x.education || []).map(e => e && e.schoolName), 6),
    location: clip(x.location && (x.location.linkedinText || (x.location.parsed && x.location.parsed.text)), 120),
    photoUrl: (() => { const pp = x.profilePicture || {}, sz = Array.isArray(pp.sizes) ? pp.sizes.filter(s => s && typeof s.url === "string" && s.width <= 400).sort((a, b) => b.width - a.width)[0] : null; const u = (sz && sz.url) || pp.url || x.photo; return typeof u === "string" && /^https:\/\/[a-z0-9.-]*licdn\.com\//i.test(u) ? u : ""; })()
  };
}
// Copies the profile picture the owner just imported (LinkedIn's CDN links expire). Only LinkedIn's image host, images only, max 400 KB.
async function fetchPhoto(url) {
  try {
    if (!/^https:\/\/[a-z0-9.-]*licdn\.com\//i.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const ct = (r.headers.get("content-type") || "").split(";")[0];
    if (!r.ok || !/^image\/(jpeg|png|webp)$/.test(ct)) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > 400000) return null;
    let bin = ""; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return { ct, b64: btoa(bin) };
  } catch (e) { return null; }
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
  { name: "friends_of_friends", description: "Names of people the user's connections know, only where everyone involved shares their network. Names only.", inputSchema: { type: "object", properties: {} } },
  { name: "list_events", description: "List the events where this user met people, with counts.", inputSchema: { type: "object", properties: {} } },
];
async function mcpCall(env, owner, scope, name, args) {
  const withNotes = scope === "people+notes";
  const people = await getPeopleFor(env, owner);
  if (name === "search_people") {
    const terms = String((args && args.query) || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(t => t.length > 1).slice(0, 12);
    if (!terms.length) return { people: [] };
    return { people: people.map(x => ({ x, s: mcpMatch(x, terms, withNotes) })).filter(r => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 10).map(r => mcpPerson(r.x, withNotes)) };
  }
  if (name === "get_person") { const x = people.find(q => q.id === (args && args.id)); return x ? mcpPerson(x, withNotes) : { error: "not found" }; }
  if (name === "friends_of_friends") { const g = await fofFor(env, owner); const nm = new Map(people.map(x => [x.id, x.card.name])), fm = new Map(g.nodes.map(n => [n.id, n.name])); return { friends_of_friends: g.edges.filter(e => fm.has(e.to)).map(e => ({ name: fm.get(e.to), knows: nm.get(e.from) || null })) }; }
  if (name === "list_events") { const m = {}; for (const x of people) { const e = x.event || "(no event)"; m[e] = (m[e] || 0) + 1; } return { events: Object.keys(m).map(e => ({ event: e, people: m[e] })) }; }
  return null;
}

// "Did you mean": speech-to-text and typos. Candidates come ONLY from the user's own saved records, are never applied silently,
// and are labelled as suggestions (an exact match is a different thing from a similar-looking word).
const ASK_STOP = new Set("who did i meet met at the a an and or of with in on from to that this those these what when where which was were is are do does works work working worked about tell me show person people guy girl someone anyone know knew anybody study studied studies school college university company companies job role title there their they them her his she he it my our any all some than then also who's whom".split(" "));
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function personFields(x) {
  const li = x.enriched && x.enriched.linkedin ? x.enriched.linkedin : {};
  return [["name", x.card && x.card.name], ["headline", x.card && x.card.headline], ["event", x.event], ["place", x.location && x.location.label], ["LinkedIn headline", li.headline], ["LinkedIn role", (li.titles || []).join(" ")], ["LinkedIn company", (li.companies || []).join(" ")], ["LinkedIn school", (li.schools || []).join(" ")], ["note", x.note]];
}
const wordsOf = s => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function askSuggestions(question, people) {
  const qWords = String(question).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const vocab = new Map(); // token -> [{p, field}]
  for (const x of people) for (const [field, val] of personFields(x)) for (const t of new Set(wordsOf(val))) { if (!vocab.has(t)) vocab.set(t, []); vocab.get(t).push({ p: x, field }); }
  const terms = qWords.filter(t => t.length >= 3 && !ASK_STOP.has(t.toLowerCase()));
  const exact = terms.filter(t => vocab.has(t.toLowerCase()));
  const out = [];
  for (const t of terms) {
    const lt = t.toLowerCase(); if (vocab.has(lt)) continue;
    const acronym = t.length <= 6 && t === t.toUpperCase() && /[A-Z]/.test(t);
    if (!acronym && exact.length) continue;
    const maxD = lt.length <= 5 ? 1 : 2;
    const cands = [];
    for (const [tok, hits] of vocab) { if (Math.abs(tok.length - lt.length) > maxD || tok.length < 3) continue; const d = lev(lt, tok); if (d > 0 && d <= maxD) cands.push({ tok, d, hits }); }
    cands.sort((a, b) => a.d - b.d || b.hits.length - a.hits.length);
    for (const c of cands.slice(0, 6)) {
      const seen = new Set(), ppl = [];
      for (const h of c.hits) if (!seen.has(h.p.id)) { seen.add(h.p.id); ppl.push({ id: h.p.id, name: h.p.card.name, matchedIn: h.field, event: h.p.event || null }); }
      out.push({ heard: t, meant: c.tok.length <= 6 ? c.tok.toUpperCase() : c.tok, distance: c.d, exactMatch: false, people: ppl.slice(0, 10), morePeople: Math.max(0, ppl.length - 10) });
    }
  }
  return out.slice(0, 8);
}
async function getPeople(env, owner) { return (await getJSON(env.KV, "ppl/" + owner)) || []; }
// Profile completion gate. A viewer unlocks other people's shared details by completing their own profile: name, a short headline and one
// useful detail (what they study, where they work or a project). Phone, photo and social accounts are never required. A LinkedIn import
// the owner already made also counts as the detail. Until then the SERVER withholds the other person's details: the saved record only
// carries what the viewer already knows from meeting them (name, headline, event, time, place, their own note and selfie).
// Silent unlock rule: a viewer is complete when ANY 3 of these 7 sections are filled, in any combination (Praj voice note, WhatsApp Oct 30 8:59 PM MST: "have three of seven sections, any three"):
// name, headline (3+ characters), an about line (3+ characters), a photo, any link, a contact (email or phone), LinkedIn details (import).
// No section is required. The count is never sent to the app or shown on the site; the app only says to add more to the profile.
const PROFILE_SECTIONS_NEEDED = 3;
async function profileStatus(env, owner) {
  const slug = await env.KV.get("own/" + owner);
  const [recRaw, enRaw, photoRaw] = slug ? await getMany(env.KV, ["card/" + slug, "enrich/" + slug, "photo/" + slug]) : [null, null, null];
  const rec = recRaw ? JSON.parse(recRaw) : null;
  const c = rec && rec.card;
  const en = enRaw ? JSON.parse(enRaw) : null;
  const li = en && en.linkedin;
  const liDetail = !!(li && ((li.titles || []).length || (li.companies || []).length || (li.schools || []).length));
  const has = (v, n) => typeof v === "string" && v.trim().length >= n;
  let n = 0;
  if (c && has(c.name, 1)) n++;
  if (c && has(c.headline, 3)) n++;
  if (c && has(c.detail, 3)) n++;
  if (slug && photoRaw !== null) n++;
  if (c && c.links && Object.values(c.links).some(v => has(v, 1))) n++;
  if (c && (has(c.email, 1) || has(c.phone, 1))) n++;
  if (liDetail) n++;
  return { complete: n >= PROFILE_SECTIONS_NEEDED };
}
function gatePerson(x, complete) {
  if (complete) return x;
  const o = { id: x.id, card: { name: x.card.name, headline: x.card.headline || "", email: "", phone: "", links: {} }, metAt: x.metAt, event: x.event, location: x.location || null, note: x.note || "", enriched: null, slug: null, locked: true };
  if (x.photo) o.photo = x.photo;
  if (x.savedPrivately) o.savedPrivately = true;
  return o;
}
async function getPeopleFor(env, owner) {
  const st = await profileStatus(env, owner);
  return (await getPeople(env, owner)).map(x => gatePerson(x, st.complete));
}

// ---- Graph sharing: consent-based friends-of-friends. Identity and edges only: never notes, places, contact fields or events. ----
// State per owner: absent = never chosen (existing users: nothing shared). New owners start {on:true, ack:false, isNew:true}: the
// onboarding notice is shown with sharing preselected, and nothing is shared until they confirm (ack) or opt out in Settings.
async function gshareState(env, owner) { return await getJSON(env.KV, "gsh/" + owner); }
async function gshareOn(env, owner) { const g = await gshareState(env, owner); return !!(g && g.on === true && (g.ack === true || g.cohort === true)); }
async function markNewOwner(env, owner) { await env.KV.put("gsh/" + owner, JSON.stringify({ on: true, ack: false, isNew: true })); }
async function opaqueId(owner) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("gfof|" + owner)); return "f_" + [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join(""); }
// Friends of friends for `viewer`. A person shows up only when ALL hold: the viewer shares and has a complete profile; the
// middle person shares and has saved the viewer back (mutual, so the viewer is inside their permissioned audience); the third
// person shares too (their own consent to be shown). Computed at query time, so revocation, deletion and opt-out apply at once.
async function fofFor(env, viewer) {
  const empty = { nodes: [], edges: [] };
  if (!(await gshareOn(env, viewer))) return empty;
  if (!(await profileStatus(env, viewer)).complete) return empty;
  const viewerSlug = await env.KV.get("own/" + viewer);
  if (!viewerSlug) return empty;
  const mine = await getPeople(env, viewer), direct = new Map();
  const mineSl = mine.slice(0, 40).filter(x => x.slug);
  const mineCards = await getMany(env.KV, mineSl.map(x => "card/" + x.slug));
  mineSl.forEach((x, i) => { const rec = mineCards[i] && JSON.parse(mineCards[i]); if (rec && rec.ownerToken && rec.ownerToken !== viewer) direct.set(rec.ownerToken, x); });
  const mids = [...direct.keys()];
  const midRaw = await getMany(env.KV, mids.flatMap(m => ["gsh/" + m, "ppl/" + m]));
  const nodes = new Map(), edges = [], need = new Set(), pend = [];
  mids.forEach((mid, i) => {
    const g = midRaw[2 * i] && JSON.parse(midRaw[2 * i]);
    if (!(g && g.on === true && (g.ack === true || g.cohort === true))) return;
    const theirs = midRaw[2 * i + 1] ? JSON.parse(midRaw[2 * i + 1]) : [];
    if (!theirs.some(t => t.slug && t.slug === viewerSlug)) return;
    const list = theirs.slice(0, 100).filter(t => t.slug); list.forEach(t => need.add("card/" + t.slug)); pend.push({ mid, list });
  });
  const cardRaw = await getMany(env.KV, [...need]), cardOf = new Map([...need].map((k, i) => [k, cardRaw[i] ? JSON.parse(cardRaw[i]) : null]));
  const owners = new Set(); for (const { list } of pend) for (const t of list) { const rec = cardOf.get("card/" + t.slug); if (rec && rec.ownerToken) owners.add(rec.ownerToken); }
  const ownerArr = [...owners], gRaw = await getMany(env.KV, ownerArr.map(o => "gsh/" + o)), shares = new Map(ownerArr.map((o, i) => { const g = gRaw[i] && JSON.parse(gRaw[i]); return [o, !!(g && g.on === true && (g.ack === true || g.cohort === true))]; }));
  for (const { mid, list } of pend) {
    const mx = direct.get(mid);
    for (const t of list) {
      const rec = cardOf.get("card/" + t.slug);
      if (!rec || !rec.ownerToken || rec.ownerToken === viewer || rec.ownerToken === mid) continue;
      if (direct.has(rec.ownerToken)) { const dx = direct.get(rec.ownerToken); if (shares.get(rec.ownerToken)) edges.push({ from: mx.id, to: dx.id, kind: "knows" }); continue; }
      if (!shares.get(rec.ownerToken)) continue;
      const nid = await opaqueId(rec.ownerToken);
      if (!nodes.has(nid)) { const nd = { id: nid, type: "friend-of-friend", name: (rec.card && rec.card.name) || "" }; Object.defineProperty(nd, "slug", { value: t.slug, enumerable: false }); Object.defineProperty(nd, "owner", { value: rec.ownerToken, enumerable: false }); nodes.set(nid, nd); }
      edges.push({ from: mx.id, to: nid, kind: "knows" });
    }
  }
  return { nodes: [...nodes.values()], edges };
}
// Each person decides separately whether friends of friends may ask for an intro to them, and whether their headline may be shown in that ask. Default: off.
async function introConsent(env, owner) { const c = (await getJSON(env.KV, "ics/" + owner)) || {}; return { on: c.on === true, headline: c.on === true && c.headline === true }; }
// Intro records expire after 30 days: they are hidden, cannot be acted on, and are removed from the list the next time that list is read or written.
const INTRO_TTL_MS = 30 * 86400000;
const introExpired = (it) => !it || Date.now() - Date.parse(it.at || 0) > INTRO_TTL_MS;
async function introPrune(env, key) { const all = (await getJSON(env.KV, key)) || []; for (const it of all) if (introExpired(it)) await jdel(env.KV, key, { id: it.id }); return all.filter(it => !introExpired(it)); }
// Shared eligibility for an intro: the target must be a friend-of-friend of the requester under the SAME rule the Map uses (fofFor), reached through this via person.
// Returns the via person's owner token, or null. Never says which condition failed.
async function introVia(env, viewer, viaPersonId, targetSlug) {
  {
    const mine = await getPeople(env, viewer), via = mine.find(x => x.id === viaPersonId && x.slug); if (!via) return null;
    const viaRec = await getJSON(env.KV, "card/" + via.slug); if (!viaRec || !viaRec.ownerToken || (await env.KV.get("own/" + viaRec.ownerToken)) === null) return null;
    const tRec = await getJSON(env.KV, "card/" + targetSlug); if (!tRec || !tRec.ownerToken || tRec.ownerToken === viewer) return null;
    const fof = await fofFor(env, viewer), nid = await opaqueId(tRec.ownerToken);
    if (!fof.nodes.some(n => n.id === nid) || !fof.edges.some(e => e.from === via.id && e.to === nid)) return null;
    if (!(await introConsent(env, tRec.ownerToken)).on) return null; // the target must have opted in to being asked for
    return viaRec.ownerToken;
  }
}
// Re-check a stored intro against the current rules. Returns the owner tokens involved, or null if anything changed (opt-out, un-save, deletion).
async function introValid(env, it, viaOwner) {
  {
    const rr = await getJSON(env.KV, "card/" + it.requesterSlug); if (!rr || !rr.ownerToken) return null;
    const viaSlug = await env.KV.get("own/" + viaOwner); if (!viaSlug) return null;
    const vp = (await getPeople(env, rr.ownerToken)).find(x => x.slug === viaSlug); if (!vp) return null;
    if ((await introVia(env, rr.ownerToken, vp.id, it.targetSlug)) !== viaOwner) return null;
    const tr = await getJSON(env.KV, "card/" + it.targetSlug); if (!tr || !tr.ownerToken) return null;
    return { reqOwner: rr.ownerToken, tgtOwner: tr.ownerToken, viaSlug, reqCard: rr.card, tgtCard: tr.card };
  }
}
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


// ---- Web Push (RFC 8030 + VAPID RFC 8292 + aes128gcm payload encryption RFC 8291). Used only from notify(), so it is OFF with cfg/notify.
// Keys: secret VAPID_JWK (ECDSA P-256 private JWK). Tests set env.PUSH_SINK(sub, payload) instead of the network.
const PUSH_HOST = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com|[a-z0-9-]+\.push\.apple\.com)$/;
const pb64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const punb64u = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
function pushEnabled(env) { return !!(env.PUSH_SINK || env.VAPID_JWK); }
async function vapidPublic(env) {
  if (env.VAPID_PUB_TEST) return env.VAPID_PUB_TEST;
  if (!env.VAPID_JWK) return "";
  const k = JSON.parse(env.VAPID_JWK);
  const raw = new Uint8Array(65); raw[0] = 4; raw.set(punb64u(k.x), 1); raw.set(punb64u(k.y), 33);
  return pb64u(raw);
}
function validSub(sub) {
  try {
    if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length > 700 || !sub.keys) return null;
    const u = new URL(sub.endpoint);
    if (u.protocol !== "https:" || !PUSH_HOST.test(u.hostname) || u.username || u.password) return null;
    if (punb64u(sub.keys.p256dh).length !== 65 || punb64u(sub.keys.auth).length !== 16) return null;
    return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, at: Date.now() };
  } catch (e) { return null; }
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}
async function pushEncrypt(sub, text) {
  const ua = punb64u(sub.keys.p256dh), auth = punb64u(sub.keys.auth), enc = new TextEncoder();
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const keyInfo = new Uint8Array([...enc.encode("WebPush: info\0"), ...ua, ...asPub]);
  const ikm = await hkdf(auth, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array([...enc.encode(text), 2]);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const hdr = new Uint8Array(21 + 65); hdr.set(salt, 0); new DataView(hdr.buffer).setUint32(16, 4096); hdr[20] = 65; hdr.set(asPub, 21);
  const out = new Uint8Array(hdr.length + ct.length); out.set(hdr, 0); out.set(ct, hdr.length); return out;
}
async function vapidHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_JWK), enc = new TextEncoder();
  const head = pb64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = pb64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:noreply@mail.prajvalarora.com" })));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  return "vapid t=" + head + "." + claims + "." + pb64u(sig) + ", k=" + (await vapidPublic(env));
}
// Returns "ok", "gone" (subscription expired, drop it) or "fail".
async function sendPush(env, sub, payload) {
  if (env.PUSH_SINK) return (await env.PUSH_SINK(sub, payload)) || "ok";
  const body = await pushEncrypt(sub, JSON.stringify(payload));
  const r = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: await vapidHeader(env, sub.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" }, body });
  if (r.status === 404 || r.status === 410) return "gone";
  return r.ok ? "ok" : "fail";
}

// ---- Notifications (built, OFF by default). Nothing in this block sends anything unless KV key cfg/notify equals "on".
// Audiences: welcome -> the new user only; request -> the person who RECEIVES it; connected -> the person who SENT the request.
// Email goes only to a verified address, at most once per event, within the existing mail caps. Web Push goes only to devices where the user pressed Enable push.
const NOTIFY_SITE = "https://robox2020.github.io/tagg/#/";
const NOTIFY_FOOT = "\n\nYou get this email because alerts are on for your Tagg account. Turn them off in Settings: " + NOTIFY_SITE + "settings";
function notifyCopy(type, name) {
  const n = String(name || "Someone").replace(/[\r\n]+/g, " ").slice(0, 80).trim() || "Someone";
  if (type === "welcome") return { title: "Welcome to Tagg", line: "Your card is ready. Share your QR when you meet someone.", subject: "Welcome to Tagg",
    text: "Hi " + n.split(" ")[0] + ",\n\nYour Tagg card is ready. Show your QR code when you meet someone, and Tagg keeps the time you met and anything you choose to add.\n\nOpen your card: " + NOTIFY_SITE + "card" + NOTIFY_FOOT };
  if (type === "request") return { title: "Connection request", line: n + " wants to connect.", subject: n + " wants to connect on Tagg",
    text: n + " sent you a connection request on Tagg.\n\nOpen Tagg to review it. You choose whether to accept.\n\nReview request: " + NOTIFY_SITE + "people" + NOTIFY_FOOT };
  if (type === "network") return { title: "Your network opened up", line: "People you may know through your connections are now visible. Open Map or People.", subject: "", text: "" };
  if (type === "scan") return { title: "Your card was opened", line: "Someone opened your Tagg card.", subject: "Someone opened your Tagg card",
    text: "Someone opened your Tagg card, for example after scanning your QR code.\n\nTagg cannot tell who it was. If they choose to connect, you will see a request in the app.\n\nOpen Tagg: " + NOTIFY_SITE + "people" + NOTIFY_FOOT };
  return { title: "Connected", line: n + " accepted your request.", subject: "You are now connected with " + n,
    text: n + " accepted your connection request on Tagg.\n\nView their profile: " + NOTIFY_SITE + "people" + NOTIFY_FOOT };
}
async function notify(env, owner, type, evId, name) {
  try {
    if (!owner || (await env.KV.get("cfg/notify")) !== "on") return { skipped: "off" };
    // The scan alert is its own switch (cfg/notify-scan) because its wording is separate.
    if (type === "scan" && (await env.KV.get("cfg/notify-scan")) !== "on") return { skipped: "scan-off" };
    if (type === "network" && (await env.KV.get("cfg/notify-net")) !== "on") return { skipped: "net-off" };
    const id = type + ":" + evId, c = notifyCopy(type, name), out = {};
    {
      const pr = await jpush(env.KV, "nt/" + owner, { id, type, title: c.title, line: c.line, at: new Date().toISOString(), read: false }, { cap: 30, dedupe: { id } });
      if (pr.added) out.inapp = true;
 }
    const prefs = (await getJSON(env.KV, "npf/" + owner)) || {};
    if (type !== "network" && prefs.email !== false && mailEnabled(env) && (await isVerified(env, owner))) {
      const prof = await getJSON(env.KV, "prof/" + owner);
      const to = prof && normEmail(prof.email);
      if (to && (await env.KV.get("suppress/" + to)) === null && (await env.KV.get("nd/email/" + id)) === null) {
        await env.KV.put("nd/email/" + id, "1", { expirationTtl: 2592000 });
        if (await mailBudgetOk(env, to)) { await sendMail(env, to, c.subject, c.text); out.email = true; }
      }
    }
    if (pushEnabled(env) && (await env.KV.get("nd/push/" + id)) === null) {
      const subs = (await getJSON(env.KV, "ps/" + owner)) || [];
      if (subs.length) {
        await env.KV.put("nd/push/" + id, "1", { expirationTtl: 2592000 });
        const keep = [], pay = { title: c.title, body: c.line, url: NOTIFY_SITE + (type === "request" || type === "connected" || type === "scan" || type === "network" ? "people" : "card"), tag: type };
        for (const sb of subs) { let r = "fail"; try { r = await sendPush(env, sb, pay); } catch (e) {} if (r !== "gone") keep.push(sb); else await jdel(env.KV, "ps/" + owner, { endpoint: sb.endpoint }); if (r === "ok") out.push = (out.push || 0) + 1; }
      }
    }
    return out;
  } catch (e) { return { error: String(e && e.message || e) }; }
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
  const has = lat !== null && lon !== null;
  // Device-reported accuracy radius in meters and the time of the GPS fix: kept only with real coordinates.
  const acc = has && typeof l.acc === "number" && isFinite(l.acc) && l.acc >= 0 && l.acc <= 100000 ? Math.round(l.acc) : null;
  const at = has && typeof l.at === "string" && !isNaN(Date.parse(l.at)) ? new Date(l.at).toISOString() : null;
  const out = { lat: has ? lat : null, lon: has ? lon : null, label, place };
  // Where the place name came from. "OpenStreetMap" names are a nearby guess, not a confirmed venue; "you" means the owner typed it.
  if (place && (l.placeSource === "OpenStreetMap" || l.placeSource === "you")) { out.placeSource = l.placeSource; out.guess = l.placeSource === "OpenStreetMap" && l.guess !== false; }
  if (acc !== null) out.acc = acc;
  if (at !== null) out.at = at;
  return out;
}
// Link an identity key (google sub or email) to an owner token, adopting/merging the device identity.
async function linkIdentity(env, authKey, deviceTok) {
  let linked = await env.KV.get(authKey);
  if (!linked) {
    linked = (deviceTok && (await env.KV.get("own/" + deviceTok)) !== null) ? deviceTok : token();
    if ((await env.KV.get("own/" + linked)) === null) { await env.KV.put("own/" + linked, ""); await putPeople(env, linked, []); await markNewOwner(env, linked); }
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
    if (new URL(req.url).pathname === "/pace") {
      // Exact global pacing: hands out time slots at least gapMs apart. One Durable Object handles one call at a time, so
      // parallel callers across all Worker instances each get their own later slot.
      const { gapMs, maxWaitMs } = await req.json();
      const t = Date.now(), last = (await this.state.storage.get("last")) || 0;
      const slot = Math.max(t, last + gapMs);
      if (slot - t > maxWaitMs) return Response.json({ refused: true });
      await this.state.storage.put("last", slot);
      return Response.json({ waitMs: slot - t });
    }
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

// First-access alert: when a person's shared network goes from empty to at least one visible person (same fofFor rule the Map and People use,
// so nothing new is disclosed), tell that person once, in-app and push only, no email, no names. Event-driven (no polling): it runs after the
// actions that can open a network (share on, profile saved, request accepted), for the actor and the people around them, within a fixed read budget.
// A permanent marker net/seen/<owner> means "already told or already seeing people", so each person is alerted at most once.
async function networkFirstAccessCheck(env, actor) {
  try {
    if ((await env.KV.get("cfg/notify")) !== "on" || (await env.KV.get("cfg/notify-net")) !== "on") return { skipped: "off" };
    // If the actor is not sharing, they can neither see anyone nor be seen, so nobody's network can have opened because of them.
    if (!(await gshareOn(env, actor))) return { skipped: "not-sharing" };
    const cands = [actor], seen = new Set([actor]);
    const add = async (people, cap) => { let n = 0; for (const x of people) { if (n >= cap || cands.length >= 16) break; if (!x.slug) continue; const rec = await getJSON(env.KV, "card/" + x.slug); const o = rec && rec.ownerToken; if (o && !seen.has(o)) { seen.add(o); cands.push(o); n++; } } };
    const mids = []; await add((await getPeople(env, actor)).slice(0, 12), 12);
    for (const m of cands.slice(1, 7)) mids.push(m);
    for (const m of mids) await add((await getPeople(env, m)).slice(0, 4), 4);
    let notified = 0, evaluated = 0;
    for (const v of cands) {
      if ((await env.KV.get("net/seen/" + v)) !== null) continue;
      if (!(await gshareOn(env, v)) || evaluated >= 8) continue;
      evaluated++;
      if ((await fofFor(env, v)).nodes.length > 0) { await env.KV.put("net/seen/" + v, "1"); await notify(env, v, "network", "n", ""); notified++; }
    }
    return { evaluated, notified };
  } catch (e) { return { error: String(e && e.message || e) }; }
}

export { networkFirstAccessCheck };
// Responses carry personal data: never cache them in browsers or shared caches, never let a browser guess the content type, send no referrer.
function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  if (!out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "private, no-cache"); out.headers.set("X-Content-Type-Options", "nosniff"); out.headers.set("Referrer-Policy", "no-referrer");
  return out;
}
const appHandler = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Create an anonymous owner identity (no card yet).
    if (p === "/api/owner" && req.method === "POST") {
      const t = token();
      await env.KV.put("own/" + t, "");
      await putPeople(env, t, []);
      await markNewOwner(env, t);
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
      const firstCard = !slug;
      if (!slug) { slug = rand(8); await env.KV.put("own/" + owner, slug); }
      const rec = { card, ownerToken: owner, slug, updatedAt: new Date().toISOString(), createdAt: (await getJSON(env.KV, "card/" + slug))?.createdAt || new Date().toISOString() };
      await env.KV.put("card/" + slug, JSON.stringify(rec));
      if (firstCard) await notify(env, owner, "welcome", owner.slice(0, 12), card.name);
      return j({ ownerToken: owner, slug });
    }

    // Public card fetch.
    const cm = p.match(/^\/api\/c\/([a-z0-9]+)$/);
    if (cm && req.method === "GET") {
      // Budget guard for anonymous previews (signed-in viewers are not counted). Per address generous enough for a shared event network, plus a daily
      // ceiling so a scripted loop or a viral burst cannot use up the free daily reads that sign-in, connect and accept also need.
      const guardTok = authOwner(req);
      if (!guardTok || (await env.KV.get("own/" + guardTok)) === null) { // a made-up Authorization header does not skip the guard
        const ip = req.headers.get("CF-Connecting-IP") || "x";
        if (await overLimit(env, "pubip/" + ip, Number(env.PUBLIC_VIEWS_PER_IP_MIN) || 240, 60))
          return j({ error: "Lots of people are opening cards right now. Please try again in a minute.", busy: true }, 429);
        if (await overLimit(env, "pubday/" + new Date().toISOString().slice(0, 10), Number(env.PUBLIC_VIEWS_PER_DAY) || 20000, 86400))
          return j({ error: "Tagg has used up today's free capacity for opening cards. It resets around 5 PM Arizona time. Signed-in people can still open cards.", busy: true, daily: true }, 429);
      }
      const rec = await getJSON(env.KV, "card/" + cm[1]);
      if (!rec) return j({ error: "not found" }, 404);
      // QR gate: the owner and scanners with a complete profile get the full card. Everyone else (including anonymous
      // guests) gets a minimal preview: name and headline only. Links, contact, detail and imports are not in the response.
      const viewer = authOwner(req);
      let full = !!(viewer && rec.ownerToken && viewer === rec.ownerToken);
      if (!full && viewer && (await env.KV.get("own/" + viewer)) !== null) full = (await profileStatus(env, viewer)).complete;
      const enr0 = await getJSON(env.KV, "enrich/" + cm[1]);
      const hasPhoto = !!(enr0 && enr0.linkedin && enr0.linkedin.hasPhoto && (await env.KV.get("photo/" + cm[1])) !== null);
      if (!full) return j({ slug: rec.slug, locked: true, photo: hasPhoto, card: { name: (rec.card && rec.card.name) || "", headline: (rec.card && rec.card.headline) || "", email: "", phone: "", links: {} }, enriched: null, verified: await isVerified(env, rec.ownerToken) });
      const enriched = await getJSON(env.KV, "enrich/" + cm[1]);
      return j({ slug: rec.slug, photo: hasPhoto, card: rec.card, enriched: enriched || null, verified: await isVerified(env, rec.ownerToken) });
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
      if (!scannerPeople.some(x => x.slug === rec.slug)) await jpush(env.KV, "ppl/" + scanner, person, { cap: 500, dedupe: { slug: rec.slug } });
      // mutual: card owner saves scanner's card back
      let mutual = false;
      const scannerSlug = await env.KV.get("own/" + scanner);
      if (scannerSlug) {
        const sRec = await getJSON(env.KV, "card/" + scannerSlug);
        if (sRec && rec.ownerToken) {
          const ownerPeople = await getPeople(env, rec.ownerToken);
          if (!ownerPeople.some(x => x.slug === scannerSlug)) await jpush(env.KV, "ppl/" + rec.ownerToken, { id: "p_" + rand(10), slug: scannerSlug, card: sRec.card, metAt: now, event: evt, location: loc, note: "", enriched: (await getJSON(env.KV, "enrich/" + scannerSlug)) || null }, { cap: 500, dedupe: { slug: scannerSlug } });
          mutual = true;
        }
      }
      return j({ scannerToken: scanner, card: rec.card, personId: person.id, mutualSaved: mutual });
    }

    // List your people.
    if (p === "/api/people" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const st = await profileStatus(env, owner);
      return j({ people: (await getPeople(env, owner)).map(x => gatePerson(x, st.complete)), profile: st });
    }

    if (p === "/api/profile/status" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      return j(await profileStatus(env, owner));
    }

    // Update/delete a person (note).
    const pm = p.match(/^\/api\/people\/([a-z0-9_]+)$/);
    // Open one saved person: re-read their CURRENT shared card so an update shows up. Your private note, place, photo and event
    // always come from your own record. A field they removed is not restored from the old snapshot. If their card is gone,
    // only the name is kept and the status says so.
    if (pm && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      if (await overLimit(env, "pget/" + owner, 300, 3600)) return j({ error: "Too many requests" }, 429);
      const list = await getPeople(env, owner);
      const i = list.findIndex(x => x.id === pm[1]);
      if (i < 0) return j({ error: "not found" }, 404);
      const person = list[i];
      const st = await profileStatus(env, owner);
      if (!person.slug) return j({ person: gatePerson(person, st.complete), cardStatus: "saved", profile: st });
      const rec = await getJSON(env.KV, "card/" + person.slug);
      if (!rec) {
        const stripped = { ...person, card: { name: person.card.name, headline: "", email: "", phone: "", links: {} }, enriched: null };
        return j({ person: gatePerson(stripped, st.complete), cardStatus: "removed", profile: st });
      }
      const fresh = { ...person, card: rec.card, enriched: (await getJSON(env.KV, "enrich/" + person.slug)) || null };
      if (JSON.stringify(fresh.card) !== JSON.stringify(person.card) || JSON.stringify(fresh.enriched) !== JSON.stringify(person.enriched || null)) { list[i] = fresh; await putPeople(env, owner, list); }
      return j({ person: gatePerson(fresh, st.complete), cardStatus: st.complete ? "live" : "locked", checkedAt: new Date().toISOString(), profile: st });
    }
    if (pm && (req.method === "PUT" || req.method === "DELETE")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const list = await getPeople(env, owner);
      const i = list.findIndex(x => x.id === pm[1]);
      if (i < 0) return j({ error: "not found" }, 404);
      if (req.method === "DELETE") { await jdel(env.KV, "ppl/" + owner, { id: pm[1] }); return j({ ok: true }); }
      const body = await req.json().catch(() => ({}));
      const before = JSON.parse(JSON.stringify(list[i]));
      if (typeof body.note === "string") list[i].note = body.note.slice(0, 2000);
      if (typeof body.event === "string") list[i].event = body.event.slice(0, 200);
      if (typeof body.placeName === "string") {
        const nm = body.placeName.trim().slice(0, 160), cur = list[i].location || { lat: null, lon: null, label: "" };
        list[i].location = nm ? { ...cur, place: nm, placeSource: "you", guess: false } : { ...cur, place: "", placeSource: undefined, guess: undefined };
        if (!nm && cur.lat == null && !cur.label) list[i].location = null;
      }
      if (body.photo === "") { delete list[i].photo; }
      else if (typeof body.photo === "string" && body.photo.startsWith("data:image/")) list[i].photo = body.photo.slice(0, 420000);
      { // Write back only the fields this edit changed, so a simultaneous edit or a newly saved person is not overwritten (atomic on the Durable Object store).
        const patch = {}; for (const f of new Set([...Object.keys(before), ...Object.keys(list[i])])) if (JSON.stringify(before[f]) !== JSON.stringify(list[i][f])) patch[f] = list[i][f] === undefined ? null : list[i][f];
        if (Object.keys(patch).length) await jpatch(env.KV, "ppl/" + owner, { id: pm[1] }, patch); }
      return j({ ok: true, person: gatePerson(list[i], (await profileStatus(env, owner)).complete) });
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
      if (slug) keys.push("card/" + slug, "enrich/" + slug, "photo/" + slug);
      keys.push("gsh/" + owner);
      for (const t of ((await getJSON(env.KV, "mcpl/" + owner)) || [])) { keys.push("mcp/" + t.h); if (t.rh) keys.push("oref/" + t.rh); }
      keys.push("mcpl/" + owner, "ppl/" + owner, "prof/" + owner, "cin/" + owner, "vcode/" + owner, "scn/" + owner, "own/" + owner, "nt/" + owner, "npf/" + owner, "ps/" + owner);
      for (const k of keys) await env.KV.delete(k);
      return j({ deleted: true });
    }



    // ---- OAuth 2.1 for Claude connectors (authorization code + PKCE S256, dynamic client registration, rotating refresh tokens).
    // The owner approves inside the Tagg app (their owner token never leaves the app); the Worker only issues read-only MCP grants.
    const ORIGIN = url.origin, APP = "https://robox2020.github.io/tagg/";
    const oerr = (error, desc, status = 400) => new Response(JSON.stringify({ error, error_description: desc }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
    const redirOk = (u) => { try { const x = new URL(u); if (x.hash) return false; if (x.protocol === "https:" && x.host === "claude.ai" && x.pathname === "/api/mcp/auth_callback") return true; if (x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1") && x.pathname === "/callback") return true; return false; } catch (e) { return false; } };
    const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/api/mcp")) {
      return j({ resource: ORIGIN + "/api/mcp", authorization_servers: [ORIGIN], scopes_supported: ["tagg.read"], bearer_methods_supported: ["header"], resource_name: "Tagg" });
    }
    if (req.method === "GET" && (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/api/mcp" || p === "/.well-known/openid-configuration")) {
      return j({ issuer: ORIGIN, authorization_endpoint: ORIGIN + "/oauth/authorize", token_endpoint: ORIGIN + "/oauth/token", registration_endpoint: ORIGIN + "/oauth/register",
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["tagg.read"] });
    }
    if (p === "/oauth/register" && req.method === "POST") {
      if (await overLimit(env, "oreg/" + (req.headers.get("CF-Connecting-IP") || "x"), 30, 3600)) return oerr("temporarily_unavailable", "Too many registrations", 429);
      const b = await req.json().catch(() => null);
      const uris = b && Array.isArray(b.redirect_uris) ? b.redirect_uris.filter(x => typeof x === "string").slice(0, 5) : [];
      if (!uris.length || !uris.every(redirOk)) return oerr("invalid_redirect_uri", "Only Claude's callback URL (https://claude.ai/api/mcp/auth_callback) or a local loopback /callback is allowed");
      const cid = "tgc_" + rand(24);
      const name = typeof b.client_name === "string" ? b.client_name.replace(/[^\w .-]/g, "").trim().slice(0, 40) || "Claude" : "Claude";
      await env.KV.put("oc/" + cid, JSON.stringify({ name, uris, at: Date.now() }), { expirationTtl: 7776000 });
      return new Response(JSON.stringify({ client_id: cid, client_name: name, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: Math.floor(Date.now() / 1000) }), { status: 201, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
    }
    if (p === "/oauth/authorize" && req.method === "GET") {
      const q = url.searchParams, cid = q.get("client_id") || "", ru = q.get("redirect_uri") || "";
      const cl = /^tgc_[a-z0-9]{24}$/.test(cid) ? await getJSON(env.KV, "oc/" + cid) : null;
      // Unknown client or unregistered redirect: never redirect, show an error instead.
      if (!cl || !cl.uris.includes(ru)) return new Response("This sign-in link is not valid. Go back to Claude and try connecting again.", { status: 400, headers: { "Content-Type": "text/plain" } });
      const back = (e) => { const r = new URL(ru); r.searchParams.set("error", e); if (q.get("state")) r.searchParams.set("state", q.get("state")); return Response.redirect(r.toString(), 302); };
      if (q.get("response_type") !== "code") return back("unsupported_response_type");
      if (!q.get("code_challenge") || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(q.get("code_challenge"))) return back("invalid_request");
      const rid = rand(24);
      await env.KV.put("oa/" + rid, JSON.stringify({ cid, ru, state: q.get("state") || "", ch: q.get("code_challenge"), name: cl.name }), { expirationTtl: 600 });
      return Response.redirect(APP + "#/connect-claude?req=" + rid, 302);
    }
    if (p === "/api/oauth/request" && req.method === "GET") {
      const rid = url.searchParams.get("req") || "";
      const r = /^[a-z0-9]{24}$/.test(rid) ? await getJSON(env.KV, "oa/" + rid) : null;
      if (!r) return j({ error: "This connection request expired. Go back to Claude and connect again." }, 404);
      return j({ name: r.name, host: new URL(r.ru).host });
    }
    if (p === "/api/oauth/approve" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const b = await req.json().catch(() => null);
      const rid = b && typeof b.req === "string" ? b.req : "";
      const r = /^[a-z0-9]{24}$/.test(rid) ? await getJSON(env.KV, "oa/" + rid) : null;
      if (!r) return j({ error: "This connection request expired. Go back to Claude and connect again." }, 404);
      await env.KV.delete("oa/" + rid);
      const back = new URL(r.ru); if (r.state) back.searchParams.set("state", r.state);
      if (!b.approve) { back.searchParams.set("error", "access_denied"); return j({ redirect: back.toString() }); }
      const list = ((await getJSON(env.KV, "mcpl/" + owner)) || []).filter(t => t.exp > Date.now());
      const keep = [];
      for (const t of list) { if (t.oauth && t.name === r.name) { await env.KV.delete("mcp/" + t.h); if (t.rh) await env.KV.delete("oref/" + t.rh); await jdel(env.KV, "mcpl/" + owner, { id: t.id }); } else keep.push(t); }
      if (keep.length >= 5) return j({ error: "You can have 5 agent connections. Remove one in Settings first." }, 400);
      const code = "tgcode_" + token() + token();
      await env.KV.put("ocd/" + (await sha256hex(code)), JSON.stringify({ owner, cid: r.cid, ru: r.ru, ch: r.ch, name: r.name, scope: b.notes === true ? "people+notes" : "people" }), { expirationTtl: 300 });
      back.searchParams.set("code", code);
      return j({ redirect: back.toString() });
    }
    if (p === "/oauth/token" && req.method === "POST") {
      const raw = await req.text();
      const f = new URLSearchParams(raw.length < 4000 ? raw : "");
      const gt = f.get("grant_type");
      const issue = async (owner, scope, name, grantId, prev) => {
        const now = Date.now(), at = "tgm_" + token() + token(), rt = "tgr_" + token() + token();
        const ah = await sha256hex(at), rh = await sha256hex(rt), AT = 3600000;
        await env.KV.put("mcp/" + ah, JSON.stringify({ owner, id: grantId, scope, exp: now + AT, oauth: true }), { expirationTtl: 7200 });
        await env.KV.put("oref/" + rh, JSON.stringify({ owner, id: grantId, scope, name }), { expirationTtl: Math.floor(MCP_TTL_MS / 1000) });
        const list = (await getJSON(env.KV, "mcpl/" + owner)) || [];
        const i = list.findIndex(t => t.id === grantId);
        if (prev && i < 0) return null;
        if (i >= 0) { await env.KV.delete("mcp/" + list[i].h); await jpatch(env.KV, "mcpl/" + owner, { id: grantId }, { h: ah, rh, exp: now + MCP_TTL_MS }); }
        else await jpush(env.KV, "mcpl/" + owner, { id: grantId, name, scope, created: now, exp: now + MCP_TTL_MS, h: ah, rh, oauth: true }, { cap: 20 });
        return { access_token: at, token_type: "Bearer", expires_in: 3600, refresh_token: rt, scope: "tagg.read" };
      };
      if (gt === "authorization_code") {
        const code = f.get("code") || "", ver = f.get("code_verifier") || "";
        const ck = "ocd/" + (await sha256hex(code));
        const rec = code.length < 200 ? await getJSON(env.KV, ck) : null;
        if (!rec) return oerr("invalid_grant", "Code is invalid or expired");
        await env.KV.delete(ck);
        if (f.get("redirect_uri") !== rec.ru || f.get("client_id") !== rec.cid) return oerr("invalid_grant", "Redirect or client does not match");
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(ver) || b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ver))) !== rec.ch) return oerr("invalid_grant", "PKCE check failed");
        const out = await issue(rec.owner, rec.scope, rec.name, rand(10), false);
        return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
      }
      if (gt === "refresh_token") {
        const rt = f.get("refresh_token") || "";
        const rk = "oref/" + (await sha256hex(rt));
        const rec = rt.length < 200 ? await getJSON(env.KV, rk) : null;
        if (!rec) return oerr("invalid_grant", "Refresh token is invalid or revoked");
        await env.KV.delete(rk);
        const out = (await env.KV.get("own/" + rec.owner)) !== null ? await issue(rec.owner, rec.scope, rec.name, rec.id, true) : null;
        if (!out) return oerr("invalid_grant", "This connection was removed");
        return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
      }
      return oerr("unsupported_grant_type", "Use authorization_code or refresh_token");
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
      await jpush(env.KV, "mcpl/" + owner, { id, name, scope, created: now, exp: now + MCP_TTL_MS, h }, { cap: 20 });
      return j({ token: tok, id, name, scope, expires: now + MCP_TTL_MS });
    }
    const tm = p.match(/^\/api\/tokens\/([a-z0-9]+)$/);
    if (tm && req.method === "DELETE") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const list = (await getJSON(env.KV, "mcpl/" + owner)) || [];
      const t = list.find(q => q.id === tm[1]);
      if (!t) return j({ error: "not found" }, 404);
      await env.KV.delete("mcp/" + t.h); if (t.rh) await env.KV.delete("oref/" + t.rh);
      await jdel(env.KV, "mcpl/" + owner, { id: tm[1] });
      return j({ revoked: true });
    }
    if (p === "/api/mcp") {
      const h = req.headers.get("Authorization") || "";
      const tok = h.startsWith("Bearer tgm_") ? h.slice(7) : "";
      const rec = tok && tok.length < 200 ? await getJSON(env.KV, "mcp/" + (await sha256hex(tok))) : null;
      let okRec = !!rec && rec.exp > Date.now() && (await env.KV.get("own/" + rec.owner)) !== null;
      // A grant made through OAuth stops working the moment the owner removes it in Settings.
      if (okRec && rec.oauth) okRec = (((await getJSON(env.KV, "mcpl/" + rec.owner)) || []).some(t => t.id === rec.id));
      if (!okRec) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Bearer resource_metadata="' + url.origin + '/.well-known/oauth-protected-resource"', ...CORS } });
      if (req.method !== "POST") return j({ error: "POST JSON-RPC only" }, 405);
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
      // Write at most once per 20 seconds per card (KV free tier allows only 1,000 writes a day); a burst of opens is one entry.
      if (!list.length || Date.now() - Date.parse(list[0].at) > 20000) {
        list.unshift({ id: "s_" + rand(8), at: new Date().toISOString() });
        await env.KV.put("scn/" + rec.ownerToken, JSON.stringify(list.slice(0, 20)), { expirationTtl: 3600 });
      }
      // Optional alert to the card's owner (OFF unless both cfg/notify and cfg/notify-scan are on). At most one per card per 30 minutes,
      // never names anyone, never says they met or have not connected, and not sent when the opener is the owner's own signed-in app.
      if (authOwner(req) !== rec.ownerToken && (await env.KV.get("nd/scan/" + slug)) === null) {
        if ((await notify(env, rec.ownerToken, "scan", slug + ":" + Math.floor(Date.now() / 1800000), "")).inapp) await env.KV.put("nd/scan/" + slug, "1", { expirationTtl: 1800 });
      }
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
      return j({ person: gatePerson(person, (await profileStatus(env, owner)).complete) });
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
      { const sl = await env.KV.get("own/" + owner), cr = sl ? await getJSON(env.KV, "card/" + sl) : null; if (cr) await notify(env, owner, "welcome", owner.slice(0, 12), cr.card && cr.card.name); }
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
      const id = "r_" + rand(10);
      const loc = cleanLocation(body.location);
      const res = await jpush(env.KV, "cin/" + rec.ownerToken, { id, name, contact, requesterToken: rt, requesterSlug: reqSlug || null,
        event: (body.event || "").slice(0, 200), location: loc, at: new Date().toISOString(), status: "pending",
        // Private to the requester: copied only into the requester's own saved person, never returned by /api/inbox.
        requesterNote: typeof body.note === "string" ? body.note.slice(0, 2000) : "" }, { cap: 50, dedupe: { requesterToken: rt, status: "pending" } });
      if (res.dup) return j({ requestId: res.dup.id, requestToken: rt, status: "pending", duplicate: true });
      await env.KV.put("crt/" + id, JSON.stringify({ owner: rec.ownerToken, id }));
      await notify(env, rec.ownerToken, "request", id, name || (reqSlug && (await getJSON(env.KV, "card/" + reqSlug))?.card?.name));
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

    // Notifications: the owner's own in-app list and preferences. Empty while cfg/notify is off.
    if (p === "/api/notify" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const items = (await getJSON(env.KV, "nt/" + owner)) || [];
      return j({ items, unread: items.filter(x => !x.read).length });
    }
    if (p === "/api/notify/read" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      await jpatch(env.KV, "nt/" + owner, {}, { read: true });
      return j({ ok: true });
    }
    if (p === "/api/notify/prefs" && (req.method === "GET" || req.method === "POST")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      let pr = (await getJSON(env.KV, "npf/" + owner)) || {};
      if (req.method === "POST") { const b = await req.json().catch(() => null); if (!b || typeof b.email !== "boolean") return j({ error: "email must be true or false" }, 400); pr = { email: b.email }; await env.KV.put("npf/" + owner, JSON.stringify(pr)); }
      const subs = (await getJSON(env.KV, "ps/" + owner)) || [];
      return j({ active: (await env.KV.get("cfg/notify")) === "on", email: pr.email !== false, push: subs.length, pushAvailable: pushEnabled(env), pushKey: await vapidPublic(env) });
    }

    if (p === "/api/push/subscribe" && (req.method === "POST" || req.method === "DELETE")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const b = await req.json().catch(() => null);
      // List edits are single atomic steps on the Durable Object store, so two devices subscribing together keep both.
      if (req.method === "DELETE") {
        if (b && typeof b.endpoint === "string") await jdel(env.KV, "ps/" + owner, { endpoint: b.endpoint }); else await env.KV.delete("ps/" + owner);
      } else {
        if (!pushEnabled(env)) return j({ error: "Push is not available yet" }, 503);
        if (await overLimit(env, "psub/" + owner, 10, 3600)) return j({ error: "Too many attempts" }, 429);
        const v = validSub(b && b.subscription);
        if (!v) return j({ error: "That is not a valid push subscription" }, 400);
        await jdel(env.KV, "ps/" + owner, { endpoint: v.endpoint });
        await jpush(env.KV, "ps/" + owner, v, { cap: 5 });
      }
      const subs = (await getJSON(env.KV, "ps/" + owner)) || [];
      return j({ push: subs.length });
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
    // Intro requests (PREP ONLY). Off unless the KV flag cfg/intro is "on"; while off every intro route answers 404 and nothing is stored. Even when on, this sends no
    // email, push or in-app alert: it only records the request in the middle person's separate intro list. Accepting, forwarding and alerts are not built.
    if (p === "/api/intro/config" && req.method === "GET") return j({ enabled: (await env.KV.get("cfg/intro")) === "on" });
    if ((p === "/api/intro" || p === "/api/intro/consent" || p === "/api/intro/candidates" || p === "/api/intros" || p === "/api/intros/respond" || p === "/api/intro-offers" || p === "/api/intro-offers/respond") && (await env.KV.get("cfg/intro")) !== "on") return j({ error: "not found" }, 404);
    if (p === "/api/intro/consent" && (req.method === "GET" || req.method === "PUT")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      if (req.method === "PUT") {
        const b = await req.json().catch(() => null); if (!b || typeof b.on !== "boolean") return j({ error: "on must be true or false" }, 400);
        await env.KV.put("ics/" + owner, JSON.stringify({ on: b.on, headline: b.on && b.headline === true, at: new Date().toISOString() }));
      }
      return j(await introConsent(env, owner));
    }
    if (p === "/api/intro/candidates" && req.method === "GET") {
      // Who the viewer could ask to be introduced to, and through whom. Computed with the Map's rule plus the target's own opt-in. Targets are opaque references.
      const owner = authOwner(req), mySlug = owner ? await env.KV.get("own/" + owner) : null;
      if (!mySlug) return j({ error: "unauthorized" }, 401);
      if (!(await profileStatus(env, owner)).complete) return j({ candidates: [], needsProfile: true });
      const fof = await fofFor(env, owner), mine = await getPeople(env, owner), out = [];
      const byId = new Map(mine.map(x => [x.id, x])), cons = new Map();
      for (const e of fof.edges) {
        const nd = fof.nodes.find(n => n.id === e.to && n.slug), vp = byId.get(e.from); if (!nd || !vp || out.length >= 30) continue;
        if (!cons.has(nd.owner)) cons.set(nd.owner, await introConsent(env, nd.owner)); const cs = cons.get(nd.owner); if (!cs.on) continue;
        const tr = cs.headline ? await getJSON(env.KV, "card/" + nd.slug) : null;
        out.push({ ref: nd.id, name: nd.name, headline: tr && tr.card ? tr.card.headline || "" : undefined, via: { personId: vp.id, name: (vp.card && vp.card.name) || "" }, requested: (await env.KV.get("intrp/" + mySlug + "/" + nd.slug)) !== null });
      }
      return j({ candidates: out });
    }
    if (p === "/api/intro" && req.method === "POST") {
      const owner = authOwner(req), mySlug = owner ? await env.KV.get("own/" + owner) : null;
      if (!mySlug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      if (body && typeof body.targetRef === "string" && typeof body.targetSlug !== "string") { const fo = await fofFor(env, owner), nd = fo.nodes.find(n => n.id === body.targetRef && n.slug); if (nd) body.targetSlug = nd.slug; }
      if (!body || typeof body.viaPersonId !== "string" || typeof body.targetSlug !== "string") return j({ error: "Not available" }, 404);
      if (await overLimit(env, "intro/" + owner, 30, 86400)) return j({ error: "Too many intro requests today" }, 429);
      if (!(await profileStatus(env, owner)).complete) return j({ error: "Complete your profile first" }, 403);
      // One answer for every reason a via or target is unavailable, so the response never reveals whether a hidden person exists or shares.
      const NA = () => j({ error: "Not available" }, 404);
      const viaOwner = await introVia(env, owner, body.viaPersonId, body.targetSlug);
      if (!viaOwner) return NA();
      await introPrune(env, "intr/" + viaOwner);
      const pairKey = "intrp/" + mySlug + "/" + body.targetSlug;
      if ((await env.KV.get(pairKey)) !== null) return j({ ok: true, duplicate: true });
      const note = typeof body.note === "string" ? body.note.slice(0, 500) : "";
      const r = await jpush(env.KV, "intr/" + viaOwner, { id: "i_" + rand(10), requesterSlug: mySlug, targetSlug: body.targetSlug, note, at: new Date().toISOString(), status: "pending" }, { cap: 50, dedupe: { requesterSlug: mySlug, targetSlug: body.targetSlug, status: "pending" } });
      await env.KV.put(pairKey, "1", { expirationTtl: 604800 });
      return j({ ok: true, duplicate: !!r.dup });
    }
    if (p === "/api/intros" && req.method === "GET") {
      // The middle person reads their own list. Each entry is re-checked now, so a revoked opt-out, deleted save or changed connection hides it at once.
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const all = await introPrune(env, "intr/" + owner), out = [];
      for (const it of all.slice(0, 20)) {
        if (it.status !== "pending") continue;
        const v = await introValid(env, it, owner); if (!v) continue;
        out.push({ id: it.id, at: it.at, note: it.note, requester: { name: v.reqCard && v.reqCard.name }, target: { name: v.tgtCard && v.tgtCard.name, headline: (await introConsent(env, v.tgtOwner)).headline ? (v.tgtCard && v.tgtCard.headline) || "" : undefined } });
      }
      return j({ intros: out });
    }
    // Middle person answers an intro. Decline just closes it. Forward re-checks every rule first, then stores an offer in the TARGET's own list. Nothing is sent to
    // anyone: no email, push or in-app alert. The target only sees the offer if they open /api/intro-offers, and only name, headline and the note the requester wrote.
    if (p === "/api/intros/respond" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const b = await req.json().catch(() => null);
      if (!b || typeof b.id !== "string") return j({ error: "id required" }, 400);
      const it = ((await getJSON(env.KV, "intr/" + owner)) || []).find(x => x.id === b.id && !introExpired(x));
      const staleF = it && it.status === "forwarding" && Date.now() - Date.parse(it.claimedAt || 0) > 60000;
      if (!it || (it.status !== "pending" && !staleF)) return j({ error: "Not available" }, 404);
      const c = await jpatch(env.KV, "intr/" + owner, { id: it.id, status: staleF ? "forwarding" : "pending" }, b.forward === true ? { status: "forwarding", claimedAt: new Date().toISOString() } : { status: "declined" });
      if (!c.patched) return j({ error: "Not available" }, 404);
      if (b.forward !== true) return j({ ok: true, status: "declined" });
      const v = await introValid(env, it, owner);
      if (!v) { await jpatch(env.KV, "intr/" + owner, { id: it.id }, { status: "withdrawn" }); return j({ error: "Not available" }, 404); }
      await jpush(env.KV, "intf/" + v.tgtOwner, { id: it.id, viaSlug: v.viaSlug, requesterSlug: it.requesterSlug, note: it.note, at: new Date().toISOString(), status: "pending" }, { cap: 50, dedupe: { id: it.id } });
      await jpatch(env.KV, "intr/" + owner, { id: it.id }, { status: "forwarded" });
      return j({ ok: true, status: "forwarded" });
    }
    if (p === "/api/intro-offers" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const out = [];
      for (const of of (await introPrune(env, "intf/" + owner)).slice(0, 20)) {
        if (of.status !== "pending") continue;
        const vr = await getJSON(env.KV, "card/" + of.viaSlug), v = vr && vr.ownerToken ? await introValid(env, { requesterSlug: of.requesterSlug, targetSlug: await env.KV.get("own/" + owner) }, vr.ownerToken) : null;
        if (!v || v.tgtOwner !== owner || !(await profileStatus(env, owner)).complete) continue;
        out.push({ id: of.id, at: of.at, note: of.note, from: { name: v.reqCard && v.reqCard.name, headline: v.reqCard && v.reqCard.headline }, via: { name: vr.card && vr.card.name } });
      }
      return j({ offers: out });
    }
    if (p === "/api/intro-offers/respond" && req.method === "POST") {
      const owner = authOwner(req), mySlug = owner ? await env.KV.get("own/" + owner) : null;
      if (!mySlug) return j({ error: "unauthorized" }, 401);
      const b = await req.json().catch(() => null);
      if (!b || typeof b.id !== "string") return j({ error: "id required" }, 400);
      const of = ((await getJSON(env.KV, "intf/" + owner)) || []).find(x => x.id === b.id && !introExpired(x));
      const staleA = of && of.status === "accepting" && Date.now() - Date.parse(of.claimedAt || 0) > 60000;
      if (!of || (of.status !== "pending" && !staleA)) return j({ error: "Not available" }, 404);
      const c = await jpatch(env.KV, "intf/" + owner, { id: of.id, status: staleA ? "accepting" : "pending" }, b.accept === true ? { status: "accepting", claimedAt: new Date().toISOString() } : { status: "declined" });
      if (!c.patched) return j({ error: "Not available" }, 404);
      if (b.accept !== true) return j({ ok: true, status: "declined" });
      { // A retry after a crash: if both saves already exist the work is done (they are direct connections now, so the intro rules no longer apply). Just record it.
        const rr0 = await getJSON(env.KV, "card/" + of.requesterSlug);
        if (rr0 && rr0.ownerToken && (await getPeople(env, owner)).some(x => x.slug === of.requesterSlug) && (await getPeople(env, rr0.ownerToken)).some(x => x.slug === mySlug)) {
          await jpatch(env.KV, "intf/" + owner, { id: of.id }, { status: "accepted" }); return j({ ok: true, status: "accepted" }); } }
      const vr = await getJSON(env.KV, "card/" + of.viaSlug), v = vr && vr.ownerToken ? await introValid(env, { requesterSlug: of.requesterSlug, targetSlug: mySlug }, vr.ownerToken) : null;
      if (!v || v.tgtOwner !== owner || !(await profileStatus(env, owner)).complete) { await jpatch(env.KV, "intf/" + owner, { id: of.id }, { status: "withdrawn" }); return j({ error: "Not available" }, 404); }
      // The target agreed: save each other, marked as an introduction (not a meeting at an event).
      const now = new Date().toISOString(), mk = (slug, card, ow) => ({ id: "p_" + rand(10), slug, card, metAt: now, event: "Introduced by " + ((vr.card && vr.card.name) || "a mutual connection"), location: null, note: "", enriched: null });
      await jpush(env.KV, "ppl/" + owner, mk(of.requesterSlug, v.reqCard), { cap: 500, dedupe: { slug: of.requesterSlug } });
      await jpush(env.KV, "ppl/" + v.reqOwner, mk(mySlug, v.tgtCard), { cap: 500, dedupe: { slug: mySlug } });
      await jpatch(env.KV, "intf/" + owner, { id: of.id }, { status: "accepted" });
      return j({ ok: true, status: "accepted" });
    }
    if (p === "/api/inbox/respond" && req.method === "POST") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      if (!body || typeof body.id !== "string") return j({ error: "id required" }, 400);
      const inbox = (await getJSON(env.KV, "cin/" + owner)) || [];
      const rq = inbox.find(x => x.id === body.id);
      if (!rq) return j({ error: "not found" }, 404);
      // Claim the request first (one atomic step on the Durable Object store) so two simultaneous taps cannot both run the accept. A claim left behind by a crash is retried after 60 seconds.
      const stale = rq.status === "accepting" && Date.now() - Date.parse(rq.claimedAt || 0) > 60000;
      if (rq.status !== "pending" && !stale) return j({ error: "already handled" }, 400);
      { const c = await jpatch(env.KV, "cin/" + owner, { id: rq.id, status: stale ? "accepting" : "pending" }, { status: "accepting", claimedAt: new Date().toISOString() });
        if (!c.patched) return j({ error: "already handled" }, 400); }
      if (!body.accept) {
        await jpatch(env.KV, "cin/" + owner, { id: rq.id }, { status: "declined" });
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
        if (op.slug) { const r = await jpush(env.KV, "ppl/" + owner, op, { cap: 500, dedupe: { slug: op.slug } }); if (r.dup) op = r.dup; }
        else { ownerPeople.unshift(op); await putPeople(env, owner, ownerPeople); }
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
            const r = await jpush(env.KV, "ppl/" + rq.requesterToken, rp, { cap: 500, dedupe: { slug: mySlug } }); if (r.dup) rp = r.dup;
          }
          requesterPersonId = rp.id;
        }
      }
      rq.status = "accepted"; rq.ownerPersonId = op.id; rq.requesterPersonId = requesterPersonId;
      await jpatch(env.KV, "cin/" + owner, { id: rq.id }, { status: "accepted", ownerPersonId: op.id, requesterPersonId });
      { const myc = await getJSON(env.KV, "card/" + (await env.KV.get("own/" + owner))); await notify(env, rq.requesterToken, "connected", rq.id, myc && myc.card && myc.card.name); }
      ctx.waitUntil((async () => { await networkFirstAccessCheck(env, owner); if (rq.requesterToken) await networkFirstAccessCheck(env, rq.requesterToken); })());
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
        let res = null; try { res = await importViaApify(env, url); } catch (e) { res = { unavailable: "network" }; }
        if (res && res.unavailable !== undefined) return j({ error: "Could not read that profile right now. Paste your profile text instead.", reason: res.unavailable }, 503);
        if (!res) return j({ error: "Could not read that profile. Is it public? You can paste your profile text instead." }, 422);
        delete res.photoUrl; data = res; source = "linkedin-link-import";
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
      const existing = await loadEnrich(env.KV, slug);
      existing.linkedin = Object.assign(fields, { source: prev.source || "linkedin-pasted-text", url: prev.url, importedAt: prev.at, confirmedAt: new Date().toISOString(),
        company: fields.companies[0] || null, title: fields.titles[0] || null, school: fields.schools[0] || null });
      await saveEnrich(env.KV, slug, existing);
      await env.KV.delete("liprev/" + body.previewId);
      return j({ ok: true, linkedin: existing.linkedin });
    }
    // Auto-import when the owner ADDS or CHANGES their own LinkedIn link, after they accepted the disclosure shown before saving it.
    // Runs once per link event (never in the background, never for other people). Stored straight to the shared card with provenance;
    // the owner can edit or remove it afterwards. The same link is not imported again after an edit or removal.
    if (p === "/api/import/linkedin/auto" && req.method === "POST") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      if (!body || body.ownProfile !== true || !["linkedin-auto-v1", "linkedin-auto-v2"].includes(body.disclosure)) return j({ error: "Accept the notice about importing your profile first" }, 400);
      const url = typeof body.url === "string" ? parseLinkedinUrl(body.url) : null;
      if (!url) return j({ error: "Paste a link like linkedin.com/in/yourname" }, 400);
      if (env.APIFY_ENABLED !== "1" || !env.APIFY_TOKEN) return j({ error: "Import from a link is unavailable right now. You can paste your profile text instead.", code: "unavailable" }, 503);
      const existing = await loadEnrich(env.KV, slug);
      if ((existing.linkedin && existing.linkedin.url === url) || (existing.linkedinRemoved && existing.linkedinRemoved.url === url)) return j({ error: "That link was already imported. Use Import again if you want to read it again.", code: "same-link" }, 409);
      if (await overLimit(env, "liimport/" + owner, 6, 3600)) return j({ error: "Too many imports - try again in an hour" }, 429);
      let res = null; try { res = await importViaApify(env, url); } catch (e) { res = { unavailable: "network" }; }
      if (res && res.unavailable !== undefined) return j({ error: res.unavailable === "paused" ? "LinkedIn link import is paused for now. Your link is saved. You can paste your profile text instead." : "Could not read that profile right now. Your link is saved. You can paste your profile text instead.", code: "unavailable" }, 503);
      if (!res) return j({ error: "Could not read that profile. Is it public? Your link is saved. You can paste your profile text instead.", code: "unreadable" }, 422);
      const now = new Date().toISOString();
      let hasPhoto = false;
      if (body.disclosure === "linkedin-auto-v2" && res.photoUrl) { const ph = await fetchPhoto(res.photoUrl); if (ph) { await env.KV.put("photo/" + slug, JSON.stringify({ ct: ph.ct, b64: ph.b64, at: now, source: "linkedin" })); hasPhoto = true; } }
      existing.linkedin = Object.assign({ about: res.about || "", experience: res.experience || [], education: res.education || [], skills: res.skills || [], headline: res.headline, titles: res.titles, companies: res.companies, schools: res.schools, location: res.location },
        { source: "linkedin-link-import", url, importedAt: now, confirmedAt: now, autoImported: true, disclosure: body.disclosure, hasPhoto,
          company: res.companies[0] || null, title: res.titles[0] || null, school: res.schools[0] || null });
      delete existing.linkedinRemoved;
      await saveEnrich(env.KV, slug, existing);
      await env.KV.put("impconsent/" + owner, JSON.stringify({ version: body.disclosure, at: now, url }));
      return j({ ok: true, linkedin: existing.linkedin });
    }
    // The owner edits imported details. Anything they clear stays cleared: it is not refilled from the provider.
    if (p === "/api/import/linkedin/edit" && req.method === "POST") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      const existing = await loadEnrich(env.KV, slug);
      if (!existing.linkedin) return j({ error: "Nothing imported to edit" }, 404);
      const f = (body && body.fields) || {};
      const list = (x, n) => asNames(Array.isArray(x) ? x.filter(v => typeof v === "string") : [], n);
      const fields = { headline: clip(f.headline, 300), titles: list(f.titles, 5), companies: list(f.companies, 6), schools: list(f.schools, 6), location: clip(f.location, 120) };
      const suppressed = Object.keys(fields).filter(k => Array.isArray(fields[k]) ? !fields[k].length : !fields[k]);
      existing.linkedin = Object.assign(existing.linkedin, fields, { editedAt: new Date().toISOString(), suppressed,
        company: fields.companies[0] || null, title: fields.titles[0] || null, school: fields.schools[0] || null });
      await saveEnrich(env.KV, slug, existing);
      return j({ ok: true, linkedin: existing.linkedin });
    }
    // GitHub: same informed, owner-initiated flow as LinkedIn. Reads only the public GitHub profile of the handle in the owner's link,
    // once, after the notice. Free public API, no key. Nothing runs on card save any more.
    if (p === "/api/import/github/auto" && req.method === "POST") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      if (!body || body.ownProfile !== true || body.disclosure !== "github-auto-v1") return j({ error: "Accept the notice about importing your profile first" }, 400);
      const gm = typeof body.url === "string" ? body.url.trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/?$/i) : null;
      if (!gm) return j({ error: "Use a link like github.com/yourname" }, 400);
      const url = "https://github.com/" + gm[1];
      const existing = await loadEnrich(env.KV, slug);
      if ((existing.github && existing.github.url === url) || (existing.githubRemoved && existing.githubRemoved.url === url)) return j({ error: "That link was already imported.", code: "same-link" }, 409);
      if (await overLimit(env, "ghimport/" + owner, 6, 3600)) return j({ error: "Too many imports - try again in an hour" }, 429);
      let r; try { r = await fetch("https://api.github.com/users/" + gm[1], { headers: { "User-Agent": "tagg-app", "Accept": "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) }); } catch (e) { r = null; }
      if (!r) return j({ error: "Could not reach GitHub right now. Your link is saved.", code: "unavailable" }, 503);
      if (r.status === 404) return j({ error: "GitHub has no public profile at that link. Your link is saved.", code: "unreadable" }, 422);
      if (r.status === 403 || r.status === 429) return j({ error: "GitHub is limiting requests right now. Your link is saved. Try Import again later.", code: "rate-limited" }, 503);
      if (!r.ok) return j({ error: "Could not read GitHub right now. Your link is saved.", code: "unavailable" }, 503);
      const u = await r.json().catch(() => null);
      if (!u || typeof u.login !== "string") return j({ error: "Could not read that profile.", code: "unreadable" }, 422);
      const now = new Date().toISOString();
      existing.github = { login: u.login, name: clip(u.name, 120) || null, bio: clip(u.bio, 300) || null, company: clip(u.company, 120) || null, avatar: typeof u.avatar_url === "string" && u.avatar_url.startsWith("https://") ? u.avatar_url : null,
        followers: Number.isFinite(u.followers) ? u.followers : null, repos: Number.isFinite(u.public_repos) ? u.public_repos : null, location: clip(u.location, 120) || null, blog: clip(u.blog, 200) || null,
        source: "github-public-api", url, importedAt: now, autoImported: true, disclosure: "github-auto-v1" };
      delete existing.githubRemoved;
      await saveEnrich(env.KV, slug, existing);
      await env.KV.put("impconsent/gh/" + owner, JSON.stringify({ version: "github-auto-v1", at: now, url }));
      return j({ ok: true, github: existing.github });
    }
    if (p === "/api/import/github/edit" && req.method === "POST") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const body = await req.json().catch(() => null);
      const existing = await loadEnrich(env.KV, slug);
      if (!existing.github) return j({ error: "Nothing imported to edit" }, 404);
      const f = (body && body.fields) || {};
      const fields = { name: clip(f.name, 120) || null, bio: clip(f.bio, 300) || null, company: clip(f.company, 120) || null, location: clip(f.location, 120) || null };
      const suppressed = Object.keys(fields).filter(k => !fields[k]);
      existing.github = Object.assign(existing.github, fields, { editedAt: new Date().toISOString(), suppressed });
      await saveEnrich(env.KV, slug, existing);
      return j({ ok: true, github: existing.github });
    }
    if (p === "/api/import/github" && req.method === "DELETE") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const existing = await loadEnrich(env.KV, slug);
      if (existing.github && existing.github.url) existing.githubRemoved = { url: existing.github.url, at: new Date().toISOString() };
      delete existing.github;
      await saveEnrich(env.KV, slug, existing);
      return j({ ok: true });
    }
    // Imported profile picture: public like the card itself, served from our own copy.
    const phm = p.match(/^\/api\/photo\/([a-z0-9]+)$/);
    if (phm && req.method === "GET") {
      const en = await getJSON(env.KV, "enrich/" + phm[1]);
      const ph = en && en.linkedin && en.linkedin.hasPhoto ? await getJSON(env.KV, "photo/" + phm[1]) : null;
      if (!ph) return new Response("not found", { status: 404, headers: CORS });
      const bin = Uint8Array.from(atob(ph.b64), c => c.charCodeAt(0));
      return new Response(bin, { status: 200, headers: { ...CORS, "Content-Type": ph.ct, "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
    }
    if (p === "/api/profile-photo" && req.method === "DELETE") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const existing = await loadEnrich(env.KV, slug);
      if (existing.linkedin) { existing.linkedin.hasPhoto = false; await saveEnrich(env.KV, slug, existing); }
      await env.KV.delete("photo/" + slug);
      return j({ ok: true });
    }
    if (p === "/api/import/linkedin" && req.method === "DELETE") {
      const owner = authOwner(req);
      const slug = owner ? await env.KV.get("own/" + owner) : null;
      if (!slug) return j({ error: "unauthorized" }, 401);
      const existing = await loadEnrich(env.KV, slug);
      if (existing.linkedin && existing.linkedin.url) existing.linkedinRemoved = { url: existing.linkedin.url, at: new Date().toISOString() };
      delete existing.linkedin; await env.KV.delete("photo/" + slug);
      await saveEnrich(env.KV, slug, existing);
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
      const people = (await getPeopleFor(env, owner)).slice(0, 60).map(x => ({
        name: x.card.name, headline: x.card.headline || null, links: Object.keys(x.card.links || {}),
        event: x.event || null, metAt: x.metAt, where: (x.location && x.location.label) || null,
        note: x.note || null,
        about: x.enriched && x.enriched.linkedin ? [x.enriched.linkedin.headline, "roles: " + (x.enriched.linkedin.titles || []).join(", "), "worked at: " + (x.enriched.linkedin.companies || [x.enriched.linkedin.company]).filter(Boolean).join(", "), "studied at: " + (x.enriched.linkedin.schools || [x.enriched.linkedin.school]).filter(Boolean).join(", "), x.enriched.linkedin.location].filter(v => v && !/: $/.test(v)).join("; ")
          : x.enriched && x.enriched.github ? [x.enriched.github.bio, x.enriched.github.company].filter(Boolean).join("; ") : null
      }));
      const fofG = await fofFor(env, owner);
      const nameOf = new Map((await getPeopleFor(env, owner)).map(x => [x.id, x.card.name])), fofNm = new Map(fofG.nodes.map(n => [n.id, n.name]));
      const fofNames = fofG.edges.filter(e => fofNm.has(e.to)).slice(0, 60).map(e => ({ name: fofNm.get(e.to), knows: nameOf.get(e.from) || null }));
      const hist = (body && Array.isArray(body.history) ? body.history : []).slice(-6).filter(h => h && (h.r === "me" || h.r === "tagg") && typeof h.t === "string").map(h => (h.r === "me" ? "USER: " : "TAGG: ") + h.t.slice(0, 500)).join("\n");
      const prompt = "You are Tagg, a personal people-memory assistant. Answer the user's question using ONLY the JSON list of people they have met (each has name, headline, event, when and where they met, a private note, and a public-profile about). If nobody matches, say so plainly and suggest what to try. When people match, name them and say when and where the user met them, plus anything useful from notes or about. Concise (under 120 words), warm, plain text, no markdown, no bullets unless listing several people.\n\nPEOPLE JSON:\n" + JSON.stringify(people) + (fofNames.length ? "\n\nFRIENDS OF FRIENDS (names only, shared with consent; say who they know, never invent details): " + JSON.stringify(fofNames) : "") + (hist ? "\n\nEARLIER IN THIS CONVERSATION (use it to resolve words like she, he, they, that person, and who else):\n" + hist : "") + "\n\nQUESTION: " + q;
      const sug = askSuggestions(q, await getPeopleFor(env, owner));
      if (sug.length) {
        const byHeard = {}; for (const s of sug) (byHeard[s.heard] = byHeard[s.heard] || []).push(s);
        const text = Object.keys(byHeard).map(h => "I found nothing in your saved people for \"" + h + "\". " + (byHeard[h].length > 1 ? "Similar words in your records: " : "A similar word in your records: ") + byHeard[h].map(s => s.meant + " (" + s.people.map(p => p.name).join(", ") + ")").join("; ") + ". This is a suggestion, not a confirmed match.").join("\n");
        return j({ answer: text, suggestions: sug, exact: false });
      }
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
      const list = await getPeople(env, body.ownerToken), adds = [];
      for (const x of incoming.slice(0, 200)) {
        const card = cleanCard(x.card); if (!card) continue;
        // Skip people the server already has (a device that synced them from here must not upload them again).
        const metAtIn = typeof x.metAt === "string" ? x.metAt : "";
        if (list.some(q => (typeof x.id === "string" && q.id === x.id) || (q.card.name === card.name && metAtIn && q.metAt === metAtIn))) continue;
        let loc = null;
        if (x.location && typeof x.location === "object") loc = { lat: x.location.lat ?? null, lon: x.location.lon ?? null, label: (x.location.label || "").slice(0, 200) };
        else if (x.place && typeof x.place === "object") loc = { lat: x.place.lat ?? null, lon: x.place.lng ?? null, label: "" };
        adds.push({ id: "p_" + rand(10), slug: null, card,
          metAt: typeof x.metAt === "string" ? x.metAt : new Date().toISOString(),
          event: (x.event || "").slice(0, 200), location: loc, note: (x.note || "").slice(0, 2000), enriched: null });
      }
      const ar = await jappend(env.KV, "ppl/" + body.ownerToken, adds, 500);
      return j({ ok: true, count: ar.total });
    }

    // Nearby place name from OpenStreetMap Nominatim (free, no key). Server side so the request carries a proper User-Agent,
    // is cached by rounded coordinates, and stays under Nominatim's 1 request per second policy. The result is a nearby
    // guess: the app labels it "Near ..." and lets the owner edit it. Coordinates are not stored here, only the cached name.
    if (p === "/api/place" && req.method === "GET") {
      const u = new URL(req.url), lat = parseFloat(u.searchParams.get("lat")), lon = parseFloat(u.searchParams.get("lon"));
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return j({ error: "lat and lon required" }, 400);
      const ip = req.headers.get("CF-Connecting-IP") || "x";
      if (await overLimit(env, "place/ip/" + ip, 40, 3600)) return j({ error: "Too many lookups" }, 429);
      const ck = "place/" + lat.toFixed(4) + "," + lon.toFixed(4);
      const hit = await getJSON(env.KV, ck);
      if (hit) return j({ ...hit, cached: true });
      // Nominatim allows at most 1 request per second in total. A single Durable Object hands out upstream time slots at least
      // 1.1 s apart (exact, across every Worker instance). A caller whose slot is more than 3 s away is refused, and the place
      // can be typed by hand. No Durable Object binding means no upstream call at all. Only called once per saved meeting.
      if (!env.RL || await overLimit(env, "place/global", 20, 60)) return j({ error: "Place lookup is busy, the place name can be added by hand", retry: true }, 429);
      const pr = await (await env.RL.get(env.RL.idFromName("place/pace")).fetch("https://rl/pace", { method: "POST", body: JSON.stringify({ gapMs: 1100, maxWaitMs: 3000 }) })).json();
      if (pr.refused) return j({ error: "Place lookup is busy, the place name can be added by hand", retry: true }, 429);
      if (pr.waitMs > 0) await new Promise(r => setTimeout(r, pr.waitMs));
      let d = null;
      try {
        const r = await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=" + lat.toFixed(5) + "&lon=" + lon.toFixed(5), { headers: { "User-Agent": "Tagg/1.0 (https://robox2020.github.io/tagg/; github.com/RoboX2020/tagg)", "Accept-Language": "en" } });
        if (r.ok) d = await r.json();
      } catch (e) { d = null; }
      if (!d || d.error) return j({ place: "", label: "", kind: "", poi: false, source: "OpenStreetMap" });
      const a = d.address || {};
      const road = ["highway", "place", "boundary", "landuse"].includes(d.category);
      const place = road ? (a.road || "") : (d.name || a.amenity || a.building || a.tourism || a.leisure || a.shop || a.road || "");
      const label = [a.city || a.town || a.village || a.suburb || a.county || "", a.state || ""].filter(Boolean).join(", ");
      const out = { place: String(place).slice(0, 160), label: label.slice(0, 160), kind: String(d.type || "").slice(0, 40), poi: !road && !!d.name, source: "OpenStreetMap" };
      await env.KV.put(ck, JSON.stringify(out), { expirationTtl: 2592000 });
      return j(out);
    }

    // Graph export: nodes + met edges.
    if (p === "/api/graph" && req.method === "GET") {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      const people = await getPeopleFor(env, owner);
      const nodes = [{ id: "me", type: "self", name: "You" }];
      const edges = [];
      for (const x of people) { nodes.push({ id: x.id, type: "person", name: x.card.name, slug: x.slug || null }); edges.push({ from: "me", to: x.id, kind: "met", at: x.metAt, event: x.event || null }); }
      const fof = await fofFor(env, owner);
      return j({ nodes: nodes.concat(fof.nodes), edges: edges.concat(fof.edges), sharing: (await gshareState(env, owner)) ? { on: await gshareOn(env, owner) } : null });
    }
    if (p === "/api/graph/sharing" && (req.method === "GET" || req.method === "PUT")) {
      const owner = authOwner(req);
      if (!owner || (await env.KV.get("own/" + owner)) === null) return j({ error: "unauthorized" }, 401);
      let g = await gshareState(env, owner);
      if (req.method === "PUT") {
        const b = await req.json().catch(() => null);
        if (!b || typeof b.on !== "boolean") return j({ error: "on must be true or false" }, 400);
        g = { on: b.on, ack: true, isNew: !!(g && g.isNew), cohort: !!(g && g.cohort), at: new Date().toISOString() };
        await env.KV.put("gsh/" + owner, JSON.stringify(g));
      }
      const st = await profileStatus(env, owner);
      return j({ choice: !g ? "unset" : (g.ack ? (g.on ? "on" : "off") : (g.cohort ? "on-until-you-choose" : "preselected-on")), needsChoice: !g || g.ack !== true, isNew: !!(g && g.isNew), cohort: !!(g && g.cohort && g.ack !== true), profileComplete: st.complete });
    }

    return j({ error: "not found" }, 404);
  },
};
// 256 KB request-body cap, enforced on the actual byte stream (see the default export below).
const MAX_BODY_BYTES = 262144;
async function readBodyCapped(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
// Any unexpected failure (for example the free daily KV write allowance running out) becomes a clean, readable 503 with CORS headers,
// not a raw platform error page that the app cannot read.
export default {
  async fetch(req, env, ctx) {
    try {
      // Reject oversized request bodies early (largest legitimate body is a pasted LinkedIn profile or a saved-people migration, well under 256 KB).
      // The Content-Length check alone is not enough: a request without that header (chunked) or with a false one used to bypass the cap.
      // Count the actual bytes from the body stream instead and re-issue the request with the verified body for the handlers below.
      if (req.method !== "GET" && req.method !== "OPTIONS") {
        const tooBig = withSecurityHeaders(j({ error: "That request is too large." }, 413));
        if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return tooBig;
        if (req.body) {
          const buf = await readBodyCapped(req.body, MAX_BODY_BYTES);
          if (buf === null) return tooBig;
          req = new Request(req, { body: buf });
        }
      }
      const res = withSecurityHeaders(await appHandler.fetch(req, env, ctx));
      // Anything that can change who is complete or sharing (card or photo saved, LinkedIn or GitHub import, share on/off, accept) re-checks the first-access alert.
      if (req.method !== "GET" && req.method !== "OPTIONS" && res.status < 400 && /^\/api\/(card|profile-photo|import\/|graph\/sharing|inbox\/respond)/.test(new URL(req.url).pathname)) {
        const h = req.headers.get("Authorization") || "", o = h.startsWith("Bearer ") ? h.slice(7) : null;
        let who = o;
        if (!who && new URL(req.url).pathname === "/api/card") who = (await res.clone().json().catch(() => null) || {}).ownerToken || null;
        if (who) ctx.waitUntil(networkFirstAccessCheck(env, who));
      }
      return res;
    }
    catch (e) {
      const m = String(e && e.message || e);
      console.log("unhandled", m.slice(0, 200));
      return withSecurityHeaders(j({ error: "Tagg is very busy right now. Please try again in a little while.", busy: /limit|quota|exceeded|KV/i.test(m) }, 503));
    }
  },
};
