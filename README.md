# Tagg

Tagg is a people memory with a personal agent. Meet someone once and Tagg remembers them - when you met, where, at which event, their links, and what you noted - and it helps with the follow-up.

## How it works

1. Create your Tagg card: name, headline, and the socials and links you want to share.
2. When you meet someone, show your Tagg QR code. They scan it with any phone camera - nothing to install - and a web page shows your card with your accounts. They tap the ones that are theirs and save.
3. Tagg saves the moment automatically: when you met, where (with your permission), and at which event. Add a quick voice or text note. Only your personal notes stay private.
4. Later, just ask: "Who did I meet at Cal Hacks who works on robotics?" Tagg answers with who they are, where and when you met, their links, and why the two of you might be worth talking to.
5. To follow up, tell Tagg to set up a call. Agent-to-agent scheduling is on the roadmap; today Tagg hands you a ready email or call.

## Status

Live v2. Real today: cards, QR exchange, mutual saving (both people get each other instantly), structured when/where/event capture, voice and text notes, natural-language ask, Save to Contacts (vCard), and automatic public-profile enrichment. Coming: sign-in verified accounts, agent-to-agent follow-up scheduling, and a visual connection graph.

## Tech

- Front end: static single-page app, no build step. HTML, CSS and vanilla JavaScript, designed to Apple's Human Interface Guidelines with an orange, black and white palette, built for phone browsers first.
- Database: Cloudflare Worker + Workers KV (`tagg-api.prajval-2029.workers.dev`). Cards, owner identities, and people records live server-side behind per-device owner tokens; graph-shaped schema (people as nodes, "met" moments as edges) with a `/api/graph` export. The browser keeps a local cache so the app still opens offline.
- QR codes encode short card slugs, so they stay sparse and scan instantly.
- Enrichment: public GitHub profiles via the GitHub API; LinkedIn via an Apify actor (enabled when an `APIFY_TOKEN` secret is set on the worker). Only links a person shares on their own card are enriched - nothing else is scraped.
- Voice notes in IndexedDB (device-local).

## Run

Serve the folder with any static server, or open `index.html`:

```
python3 -m http.server 8000
```
