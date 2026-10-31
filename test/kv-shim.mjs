// Minimal in-memory stand-in for a Workers KV namespace, so the real worker code runs unchanged in Node.
export class MemoryKV {
  constructor() { this.m = new Map(); }
  async get(k) { const e = this.m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { this.m.delete(k); return null; } return e.v; }
  async put(k, v, opts) { this.m.set(k, { v: String(v), exp: opts && opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 }); }
  async delete(k) { this.m.delete(k); }
  async list(o) { const pre = (o && o.prefix) || ""; return { keys: [...this.m.keys()].filter(k => k.startsWith(pre)).slice(0, (o && o.limit) || 1000).map(name => ({ name })) }; }
}
