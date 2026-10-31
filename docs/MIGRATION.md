# Storage move: Workers KV to Durable Object (DO) store

Status: procedure and tests only. Nothing has been exported, imported or cut over. The user has not approved a cutover.
Production = worker.js at 7f01a99 (tag deployed-prod) on KV. The DO build is worker-do.js and has run only on staging with synthetic data.

## What is built and tested, and what is not

| Piece | State |
| --- | --- |
| DO store with atomic ops (test/*-do.test.mjs, fault-do) | built, tested on synthetic data |
| Encrypted export, restore, delta pass, reverse copy, TTL handling | tested as a model on SQLite (test/backup.test.mjs, 12 checks) |
| Write freeze flag `cfg/freeze` (writes get 503, reads work) | built, tested in test/api.test.mjs (KV and DO mode) |
| Operator export script (KV list + bulk read, encrypt) | NOT BUILT |
| Authenticated import route on the DO build, open only during a window | NOT BUILT (needs a new secret in the vault, user visible decision) |
| Staging rehearsal with a synthetic KV namespace end to end | NOT DONE |
| Live data export | NOT DONE, held for the user's decision |

## Requirements before any live step

1. The user approves the cutover in their own words.
2. A backup key (32 random bytes) is generated and stored in the vault. It is never printed, never in chat, never in a file kept after the run. Without the key in the vault the export is not started.
3. The import window secret is created through a vault request and set as a Worker secret. It is removed after the move.
4. Rehearsal passes on staging: synthetic KV namespace, export, import, compare counts and per-key hashes, rollback, with the exact scripts used live.
5. Old KV namespace is kept untouched for at least 30 days. No deletion of old backups or namespaces.

## Procedure

Order matters. Each step has a stop condition.

1. Announce nothing to users. Pick a low-traffic window.
2. Snapshot A (read-only safety copy, before the freeze): list keys with the Cloudflare KV API (keys carry `expiration`), bulk-read values, encrypt with AES-256-GCM using the vault key, authenticated header `tagg-backup-v1`, store the blob outside the repo. Record key count and a SHA-256 of the sorted key list. Stop if any read fails.
3. Freeze writes: set KV `cfg/freeze` to `on`. From now on every POST, PUT, PATCH and DELETE returns 503 with Retry-After 120 and the message "Tagg is being moved to new storage. Try again in a few minutes." Reads keep working. Wait 60 seconds so in-flight writes finish (KV is eventually consistent, so also wait for global propagation, 60 seconds is the documented upper bound for most reads, check the KV docs before the run).
4. Snapshot B: repeat step 2. Compare counts and key list hash with A. Keys that differ are the writes that landed between A and the freeze. B is the migration source. A stays as the older fallback.
5. Skip short-lived counter keys (rate limits, daily view ceiling). Convert TTL to remaining seconds at import time. Expired keys are skipped. Survivors keep their original absolute expiry (tested).
6. Import B into the DO store through the import route (window open, secret held in the vault). Compare: key count, and for every key a hash of key plus value. Stop and keep the freeze on if any mismatch.
7. Deploy the DO worker pointing at the new store with `cfg/freeze` still on. Run the smoke checks on synthetic accounts that were created in step 0 of the rehearsal only. Check: an existing real login works (read only), card view, people list. Do not write.
8. Unfreeze on the DO build: clear `cfg/freeze` in the new store. Watch error rate and CPU in the dashboard for 30 minutes.
9. Rollback trigger: error rate above the pre-move level, any failed login that should work, or any count mismatch. Rollback steps:
   a. Set freeze on the DO side (writes 503).
   b. Export the DO store (same encrypted format), this holds any writes since the unfreeze.
   c. Replay those writes into KV with the delta pass (keys changed since unfreeze, deletes included). The delta model is tested (log of changed keys, converges including delete).
   d. Redeploy the KV worker from tag deployed-prod (7f01a99). Set KV `cfg/freeze` off.
   e. Verify counts against B plus the delta.
   Writes made during the DO period are the only data at risk; the freeze in 9a bounds that.
10. After 30 quiet days and a separate user decision, the old namespace may be retired. Never before.

## Limits and honest caveats

- There is no write log on production KV. The freeze replaces it. Without the freeze, a delta pass cannot be guaranteed complete. Do not run the move without it.
- Users see "Tagg is being moved" for the length of steps 3 to 8. Expect minutes, not seconds, for a few thousand keys. It has not been timed on real volume.
- KV reads are eventually consistent. Step 3's wait and step 4's comparison are how we detect stale reads. A mismatch between A and B is expected and not an error; a mismatch between B and the import is an error.
- The freeze does not stop GETs that bump counters. Those keys are not migrated.
- Free plan limits: KV 1,000 writes a day, 100,000 reads a day. The export is reads only. The rollback delta replays writes into KV and must stay under the daily write cap, so do not run the move on a day that already used most of it. Check usage in the dashboard first.
- DO storage and request limits on the Free plan come from Cloudflare's current docs. Re-read them on the day.
- Passwords are stored as PBKDF2 hashes and move as opaque values. Nothing is rehashed or weakened in the move.
