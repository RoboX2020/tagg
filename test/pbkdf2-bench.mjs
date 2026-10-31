// CPU-time measurement for the worker's exact hashPassword path (PBKDF2-SHA256, 100k iterations).
// process.cpuUsage() counts real CPU microseconds, unlike wall time.
import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;
function b64(buf) { return Buffer.from(buf).toString("base64"); }
async function hashPassword(pw, saltB64, iter) {
  const key = await subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(saltB64, "base64"), iterations: iter }, key, 256);
  return b64(bits);
}
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const saltB64 = Buffer.from(salt).toString("base64");
// warmup
await hashPassword("warmup password", saltB64, 100000);
const rows = [];
for (let i = 0; i < 10; i++) {
  const c0 = process.cpuUsage();
  const w0 = performance.now();
  await hashPassword("correct horse battery staple", saltB64, 100000);
  const c1 = process.cpuUsage(c0);
  const w1 = performance.now() - w0;
  rows.push({ cpu_ms: (c1.user + c1.system) / 1000, wall_ms: w1 });
}
rows.sort((a, b) => a.cpu_ms - b.cpu_ms);
console.log("PBKDF2-SHA256 100k iterations, Node", process.version, "(OpenSSL-backed WebCrypto)");
console.log("cpu_ms  :", rows.map(r => r.cpu_ms.toFixed(1)).join(" "));
console.log("wall_ms :", rows.map(r => r.wall_ms.toFixed(1)).join(" "));
console.log("median cpu_ms:", rows[5].cpu_ms.toFixed(1), " min:", rows[0].cpu_ms.toFixed(1), " max:", rows[9].cpu_ms.toFixed(1));
