// Body-cap tests: the 256 KB request-body limit must hold on the actual bytes,
// not only on the Content-Length header. Chunked/streamed bodies have no
// Content-Length, and a header can lie. Run: node test/bodycap.test.mjs
import assert from "node:assert/strict";
import worker from "../worker/worker.js";
import { MemoryKV } from "./kv-shim.mjs";

const env = { KV: new MemoryKV(), GOOGLE_CLIENT_ID: "test-client", SIGNUP_PER_HOUR: "200" };
const ctx = { waitUntil() {} };
let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("ok -", name); }

const CAP = 262144;
function streamBody(byteLength, fill = 120) {
  const chunk = new Uint8Array(65536).fill(fill);
  return new ReadableStream({
    start(c) {
      let left = byteLength;
      while (left > 0) { const n = Math.min(left, chunk.length); c.enqueue(n === chunk.length ? chunk : chunk.slice(0, n)); left -= n; }
      c.close();
    },
  });
}
// A streamed body has no Content-Length, exactly like a chunked request.
function streamReq(path, bytes, extraHeaders = {}) {
  return new Request("http://localhost" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: streamBody(bytes),
    duplex: "half",
  });
}

// 1. Oversized streamed body, no Content-Length: must be 413, not a handler error.
{
  const r = await worker.fetch(streamReq("/api/card", CAP + 1), env, ctx);
  ok("chunked body over 256 KB (no Content-Length) is refused with 413", r.status === 413 && (await r.json()).error === "That request is too large.");
}

// 2. Oversized streamed body with a LYING small Content-Length: must still be 413.
{
  const r = await worker.fetch(streamReq("/api/card", CAP + 1000, { "content-length": "100" }), env, ctx);
  ok("a false small Content-Length does not bypass the cap", r.status === 413);
}

// 3. Oversized body with honest Content-Length: still 413 (original behavior kept).
{
  const r = await worker.fetch(streamReq("/api/card", CAP + 1, { "content-length": String(CAP + 1) }), env, ctx);
  ok("honest oversized Content-Length is refused with 413", r.status === 413);
}

// 4. A legitimate streamed request well under the cap still works end to end.
{
  const body = new TextEncoder().encode(JSON.stringify({ email: "stream@example.com", password: "stream pass", name: "Stream Test" }));
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } }), duplex: "half",
  });
  const r = await worker.fetch(req, env, ctx);
  const b = await r.json();
  ok("streamed JSON body under the cap reaches the handler (signup 200)", r.status === 200 && !!b.ownerToken);
}

// 5. A body of exactly the cap size is allowed through (boundary, not off-by-one).
{
  // Pad a valid signup payload to exactly CAP bytes with a long (unused) name field.
  const base = { email: "exact@example.com", password: "exact pass", name: "" };
  base.name = "n".repeat(CAP - JSON.stringify(base).length);
  const raw = new TextEncoder().encode(JSON.stringify(base));
  assert.equal(raw.length, CAP);
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json" },
    body: new ReadableStream({ start(c) { c.enqueue(raw); c.close(); } }), duplex: "half",
  });
  const r = await worker.fetch(req, env, ctx);
  ok("a body of exactly 256 KB is not refused for size", r.status !== 413);
}

// 6. No-body POST still works (nothing to count).
{
  const r = await worker.fetch(new Request("http://localhost/api/owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }), env, ctx);
  ok("ordinary POST with declared small body unaffected", r.status === 200 && !!(await r.json()).ownerToken);
}

console.log("passed:", passed);
