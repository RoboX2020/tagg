# Tagg

Tagg is a people memory with a personal agent. Meet someone once and Tagg remembers them - when you met, where, at which event, their links, and what you noted - and it helps with the follow-up.

## How it works

1. Create your Tagg card: name, headline, and the socials and links you want to share.
2. When you meet someone, show your Tagg QR code. They scan it with any phone camera - nothing to install - and a web page shows your card with your accounts. They tap the ones that are theirs and save.
3. Tagg saves the moment automatically: when you met, where (with your permission), and at which event. Add a quick voice or text note. Only your personal notes stay private.
4. Later, just ask: "Who did I meet at Cal Hacks who works on robotics?" Tagg answers with who they are, where and when you met, their links, and why the two of you might be worth talking to.
5. To follow up, tell Tagg to set up a call. Agent-to-agent scheduling is on the roadmap; today Tagg hands you a ready email or call.

## Status

Early live version. Real today: cards, QR exchange, saving the moment, voice and text notes, natural-language ask. Coming: sign-in verified accounts and agent-to-agent follow-up scheduling.

Everything is stored locally on each device. No accounts, no tracking.

## Tech

Static single-page app - no build step, no backend. HTML, CSS and vanilla JavaScript; QR codes generated client-side; voice notes in IndexedDB; cards in localStorage. Designed to Apple's Human Interface Guidelines with an orange, black and white palette, built for phone browsers first.

## Run

Serve the folder with any static server, or open `index.html`:

```
python3 -m http.server 8000
```
