# TAGG storage: Workers KV -> D1 migration plan (pending approval)

## Why
KV Free allows 1,000 writes/day account-wide (developers.cloudflare.com/kv/platform/pricing/). Measured per-action
costs mean a few dozen new connections a day can exhaust it. D1 Free allows 100,000 rows written and 5,000,000 rows
read per day, 5 GB storage, resets 00:00 UTC, hard-fails with errors on exceed (never bills on Free)
(developers.cloudflare.com/d1/platform/pricing/).

## Measured per-action cost on D1 (test/d1count.mjs, local node:sqlite harness)
| action | D1 queries | rows read | rows written |
| --- | --- | --- | --- |
| signup (email) | 10 | 0 | 7 |
| create card | 5 | 1 | 2 |
| connect request | 7 | 3 | 2 |
| accept request (mutual save) | 16 | 10 | 3 |
| one 4s inbox poll | 4 | 4 | 0 |

So one brand-new user making their first connection costs ~15-20 rows written (vs ~10-15 KV writes today): the daily
ceiling moves from roughly 60-100 new connections/day to ~5,000+. Polling moves from KV reads (100k/day, ~4 always-open
tabs) to 4 rows read per poll (5M/day, ~50+ always-open tabs). Peak queries per request: 16, under the Free limit of
50 queries per Worker invocation (developers.cloudflare.com/d1/platform/limits/).

## What changes in code (branch feat/d1-store)
- worker/store-d1.js: D1KV - same surface as the KV binding, plus atomic jpush/jpatch/jmerge via compare-and-swap
  retries (fixes concurrent connection requests overwriting each other, same guarantee as the DO prototype).
- worker/worker-d1.js: alternate entry; wraps the app with D1KV. STORE_MODE=dual also mirrors every write to KV.
- worker/schema-d1.sql: one table kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER).
- scripts/migrate-kv-to-d1.mjs: copy-only loader (KV read -> D1 inserts) with --verify. Never writes or deletes KV.
- worker.js: the 503 "busy" detector also matches D1 limit errors. No other app-code change.

## Caveats (grounded in the docs above)
- Row quotas are not headroom for sloppy queries: every query here is a primary-key lookup or bounded primary-key
  prefix scan, so 1 key = 1 row read. An unindexed filter would scan the whole table and burn rows read. Indexes add
  one extra row written per indexed column on each write.
- Expiry: KV expires keys by itself; D1 rows are filtered at read time and need an occasional sweep
  (DELETE counts as rows written). Only nd/* markers use TTLs, so a weekly manual sweep is plenty.
- Free-plan exceed = hard errors, not charges. There is no way to be billed without upgrading the plan.
- D1 is single-writer per database; concurrent writes serialize. Compare-and-swap retries absorb the rare collision.

## Rollout (each step only with Praj's approval)
1. Create the database (account change): `npx wrangler d1 create tagg-store`, paste id into wrangler.toml.
2. Apply schema; run the copy script; run --verify (counts + spot values).
3. Deploy worker-d1.js with STORE_MODE=dual: app reads/writes D1, every write also mirrored to KV. KV stays complete.
4. Watch a day. To roll back: redeploy worker.js (KV is current thanks to the mirror - zero data loss).
5. Once confident: STORE_MODE=d1 (stop mirroring). KV remains as a frozen backup; remove only with a separate yes.
