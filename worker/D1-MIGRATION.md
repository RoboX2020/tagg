# TAGG storage: Workers KV -> D1 migration plan (pending approval - nothing here has run against the account)

## Why
KV Free allows 1,000 writes/day account-wide (developers.cloudflare.com/kv/platform/pricing/). Measured per-action
costs mean a few dozen new connections a day can exhaust it. D1 Free allows 100,000 rows written and 5,000,000 rows
read per day, 5 GB storage, 10 databases, resets 00:00 UTC, and on Free an exceeded limit returns errors - it cannot
bill (developers.cloudflare.com/d1/platform/pricing/ and /d1/platform/limits/).

## What the numbers are - and are not
test/d1count.mjs measures the storage layer against a LOCAL node:sqlite harness that emulates the D1 API. These are
harness estimates of rows touched per action, NOT Cloudflare-metered billing numbers:
| action | D1 queries | rows read | rows written |
| --- | --- | --- | --- |
| signup (email) | 10 | 0 | 7 |
| create card | 5 | 1 | 2 |
| connect request | 7 | 3 | 2 |
| accept request (mutual save) | 16 | 10 | 3 |
| one 4s inbox poll | 4 | 4 | 0 |

If these hold against real D1, the daily write ceiling moves from ~60-100 new connections/day to the low thousands,
and polling from ~4 always-open tabs (KV reads) to dozens. Treat "low thousands" as an estimate to validate on a
staging deployment with the dashboard's D1 row metrics before calling it capacity.
The functional test results (304 API checks in each of KV / DO / D1 modes, 8 dual-mode checks) also ran against the
shim. Real-D1 behavior is validated in rollout step 3, not assumed.

## Caveats (grounded in the docs above)
- Row quotas are not headroom for sloppy queries: every query here is a primary-key lookup or bounded primary-key
  prefix scan, so 1 key = 1 row read. Indexes add one extra row written per indexed column per write. We add none.
- Expiry: KV expires keys by itself; D1 rows are filtered at read time and physically removed by an occasional sweep
  (DELETE counts as rows written). Only nd/* markers use TTLs, so a rare manual sweep is enough.
- D1 is single-writer per database; concurrent writes serialize. Compare-and-swap retries absorb collisions.

## Code (branch feat/d1-store)
- worker/store-d1.js: D1KV - same surface as the KV binding, plus atomic jpush/jpatch/jmerge via compare-and-swap
  retries (same concurrency guarantee as the DO prototype: simultaneous connects cannot overwrite each other).
- worker/worker-d1.js: alternate entry. STORE_MODE=dual also mirrors every write to KV.
- scripts/migrate-kv-to-d1.mjs: copy-only KV -> D1 loader with --verify. Never writes or deletes KV.
- scripts/sync-d1-to-kv.mjs: reverse copy (D1 -> KV) for rollback after any mirror gap.
- worker.js: the 503 "busy" detector also matches D1 limit errors. No other app-code change.

## Dual mode, honestly
- Dual mirrors EVERY write to KV, so the KV 1,000/day cap still binds during the dual window. Dual is a transition
  tool, not the scaled state; scale arrives only at the D1-only step.
- If a KV mirror write fails after D1 succeeded (e.g. KV quota exhausted), the user request still succeeds, KV goes
  stale for that key, the failure is logged by key category only ("KV mirror write failed for card/*" - keys embed owner tokens, so identifiers are never logged) and counted. Rollback is loss-free
  only while the mirror has zero failures; after any failure, run scripts/sync-d1-to-kv.mjs first (it restores D1
  state into KV; each restore is a KV write, so a big store may need a quiet window or more than one day).
- Copy-window race: the loader copies KV while live writes may continue. Run it in a quiet window and re-run it
  immediately before enabling dual (upserts make it idempotent), then --verify. Residual risk: a write landing
  between the final copy and the dual deploy is missing from D1 until the next write touches that key; at TAGG's
  current traffic (a handful of writes/day) a late-night window makes this near-zero, and --verify spot-checks.

## Rollout (every step only with Praj's approval)
0. Verify the account's actual Workers plan on the Cloudflare dashboard (browser, saved session) before any
   no-billing claim. Do not infer it from behavior.
1. Create the database (account change): wrangler d1 create tagg-store. The current API token has no D1 permission
   (D1 list call returned an auth error), so this needs the token's scope widened - doable in the dashboard with the
   saved session - or Praj creating the DB himself. No credential is disclosed either way.
2. Apply schema; run the copy loader in a quiet window; re-run it; --verify.
3. Deploy a STAGING worker on real D1 first: rerun the API suite against it (TAGG_API=<staging>) and read the
   dashboard's D1 row metrics against the harness estimates. Only then deploy worker-d1.js to production with
   STORE_MODE=dual.
4. Watch a day. Rollback: if x-mirror-failures stayed 0 in logs, redeploy worker.js (loss-free). Otherwise run
   sync-d1-to-kv.mjs first, then redeploy.
5. Once confident: STORE_MODE=d1 (stop mirroring). KV stays as a frozen backup; removing it is a separate yes.
