// RateLimiter Durable Object: exact enforcement under concurrent calls. Run: node test/dolimit.test.mjs
// The stub models the runtime: blockConcurrencyWhile serializes callbacks (one at a time), storage ops
// have real latency, and any storage op that starts while another is in flight is recorded as a race.
// A handler that forgets the serialization primitive over-admits and trips the race detector here.
import assert from "node:assert/strict";
const { RateLimiter } = await import("../worker/worker.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("ok -", name); }

function mkState() {
  const data = new Map();
  let busy = 0, races = 0, tail = Promise.resolve();
  return {
    races: () => races,
    storage: {
      get: async (k) => { if (busy > 0) races++; busy++; await sleep(3); busy--; return data.get(k); },
      put: async (k, v) => { if (busy > 0) races++; busy++; await sleep(1); busy--; data.set(k, v); },
    },
    blockConcurrencyWhile: (fn) => { const p = tail.then(fn); tail = p.catch(() => {}); return p; },
    _data: data,
  };
}

// 50 concurrent hits against one counter with max 10: exactly 10 admitted, counter reads back 10, zero races.
{
  const state = mkState();
  const obj = new RateLimiter(state);
  const results = await Promise.all(Array.from({ length: 50 }, () =>
    obj.fetch(new Request("https://rl/hit", { method: "POST", body: JSON.stringify({ max: 10, windowSec: 3600 }) })).then((r) => r.json())));
  const admitted = results.filter((r) => !r.over).length;
  ok("50 concurrent hits admit exactly the cap", admitted === 10);
  ok("no interleaved storage access under concurrency", state.races() === 0);
  ok("counter reflects exactly the admitted count", (await state.storage.get("r")).n === 10);
}

// A window that already expired resets and admits again.
{
  const state = mkState();
  const obj = new RateLimiter(state);
  await obj.fetch(new Request("https://rl/hit", { method: "POST", body: JSON.stringify({ max: 1, windowSec: -1 }) }));
  const again = await (await obj.fetch(new Request("https://rl/hit", { method: "POST", body: JSON.stringify({ max: 1, windowSec: 3600 }) }))).json();
  ok("expired window resets and admits", again.over === false);
}

// Persistence: state lives in state.storage, so a fresh object over the same storage keeps the count.
{
  const state = mkState();
  await new RateLimiter(state).fetch(new Request("https://rl/hit", { method: "POST", body: JSON.stringify({ max: 2, windowSec: 3600 }) }));
  const revived = new RateLimiter(state);
  const r1 = await (await revived.fetch(new Request("https://rl/hit", { method: "POST", body: JSON.stringify({ max: 2, windowSec: 3600 }) }))).json();
  const r2 = await (await revived.fetch(new Request("https://rl/hit", { method: "POST", body: JSON.stringify({ max: 2, windowSec: 3600 }) }))).json();
  ok("count survives object eviction (storage-backed)", r1.over === false && r2.over === true);
}
console.log(`\nDurable Object limiter checks passed: ${passed}`);
