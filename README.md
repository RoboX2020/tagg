# Tagg

Tagg is a people memory with a personal agent. Meet someone once and Tagg remembers them - when you met, where, at which event, their links, and what you noted - and it helps with the follow-up.

## How it works

1. Create your Tagg card: name, headline, and the socials and links you want to share.
2. When you meet someone, show your Tagg QR code. They scan it with any phone camera - nothing to install - and a web page shows your card with your accounts. They tap the ones that are theirs and save.
3. Tagg saves the moment automatically: when you met, where (with your permission), and at which event. Add a quick voice or text note. Only your personal notes stay private.
4. Later, just ask: "Who did I meet at Cal Hacks who works on robotics?" Tagg answers with who they are, where and when you met, their links, and why the two of you might be worth talking to.
5. To follow up, tell Tagg to set up a call. Agent-to-agent scheduling is on the roadmap; today Tagg hands you a ready email or call.

## Status

Live v4. Real today, all covered by automated tests (see Tests):

- **Accounts**: email + password (PBKDF2-SHA256, per-user salt, login rate limit) or Google sign-in. Signing up happens on the scan page itself, so scanning a QR carries the connection through signup with nothing to find again afterwards.
- **Reciprocal profiles**: when the card owner accepts, both people save each other's card.
- **Meeting memory**: one shared timestamp and event for both sides, plus an optional location (coordinates, nearby place name, Map and Street View links). Location is off by default and only sent if the scanner turns it on.
- **Private context**: each person keeps their own note, voice-to-text dictation, and selfie. These are never part of the profile exchange and the other side never sees them.
- Save to Contacts (vCard), Ask Tagg (Gemini), connection graph, installable PWA, Apple Wallet pass (free third-party signer).

Not built: email verification and password reset (needs an email sender), agent-to-agent scheduling.

## Tech

- **Front end** (`index.html`, `app.js`, `styles.css`): static single-page app, no build step, vanilla JavaScript, Apple HIG style, orange/black/white. This is what GitHub Pages serves. Pages is static hosting only - it is not the backend.
- **Backend** (`worker/worker.js`): Cloudflare Worker + Workers KV on the free tier. Accounts, cards, people, and connection requests live here.
- Street View and Map are plain links to Google Maps (no API key, no cost). Place names come from OpenStreetMap Nominatim at low volume.
- Voice-to-text uses the browser's built-in speech recognition (free; not available in every browser, the button hides itself).
- Enrichment: public GitHub profiles, optional LinkedIn via Bright Data/Apify when a secret is set. Only links a person put on their own card are enriched.

## Run it

Front end only, against the live API: `python3 -m http.server 8000`

Everything locally, with the real worker code and in-memory storage:

```
node test/serve.mjs          # API on http://localhost:8787
python3 -m http.server 8000  # app on http://localhost:8000
# in the browser console:  localStorage.setItem("tagg.api", "http://localhost:8787")
```

## Deploy the backend

```
cd worker
npx wrangler login
npx wrangler secret put GEMINI_API_KEY      # optional extras: GITHUB_TOKEN, BRIGHTDATA_API_KEY, APIFY_TOKEN
npx wrangler deploy
```

`wrangler.toml` holds the KV namespace id and the Google client id (neither is a secret). If you deploy to a new Worker URL, change `API` near the top of `app.js`.

## Tests

```
node test/api.test.mjs                  # 23 API checks: signup, login, rate limit, connect, consent, privacy
npm i puppeteer-core && node test/ui.test.mjs   # two real browsers: Bob scans, signs up, Alice accepts
```
