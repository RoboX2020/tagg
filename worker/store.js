// PROTOTYPE (not deployed, off by default): a SQLite-backed Durable Object that holds Tagg's key-value data, plus a per-request client that
// batches reads and buffers writes so one user action costs a handful of Durable Object calls instead of one per key.
// Why: Workers KV free tier allows 1,000 writes/day; Durable Object SQLite free allows 100,000 rows written/day, 5M rows read/day and 100,000
// requests/day, and each call to a Durable Object also counts as one of the 50 subrequests a free Worker request may make.
// Data model is the same as KV (string key, string value, optional expiry), so the Worker code does not change shape.

export class Store {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)");
  }
  // One request = one ordered batch of operations, executed together. ops: {o:"get",k} {o:"put",k,v,ttl?} {o:"del",k} {o:"list",prefix,limit?}
  async fetch(req) {
    const { ops } = await req.json();
    const now = Date.now(), out = [];
    for (const op of ops) {
      if (op.o === "put") { this.sql.exec("INSERT INTO kv (k,v,exp) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp", op.k, op.v, op.ttl ? now + op.ttl * 1000 : null); out.push(null); }
      // Migration-only ops (used by worker/migrate-worker.js): write with an absolute expiry, count live rows, read a page of live rows after a key.
      else if (op.o === "putabs") { if (op.exp && op.exp <= now) { out.push(false); } else { this.sql.exec("INSERT INTO kv (k,v,exp) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp", op.k, op.v, op.exp || null); out.push(true); } }
      else if (op.o === "count") { out.push(Number([...this.sql.exec("SELECT COUNT(*) AS n FROM kv WHERE exp IS NULL OR exp > ?", now)][0].n)); }
      else if (op.o === "page") { out.push([...this.sql.exec("SELECT k, v, exp FROM kv WHERE k > ? AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT ?", String(op.after || ""), now, Math.min(Number(op.limit) || 50, 200))].map(r => ({ k: r.k, v: r.v, exp: r.exp || null }))); }
      else if (op.o === "del") { this.sql.exec("DELETE FROM kv WHERE k=?", op.k); out.push(null); }
      else if (op.o === "get") { const r = [...this.sql.exec("SELECT v, exp FROM kv WHERE k=?", op.k)][0]; out.push(r && (!r.exp || r.exp > now) ? r.v : null); }
      else if (op.o === "jpush") {
        // Atomic list insert: read, de-duplicate, prepend, trim and write inside one Durable Object turn, so concurrent requests cannot overwrite each other.
        const r = [...this.sql.exec("SELECT v, exp FROM kv WHERE k=?", op.k)][0]; let arr = []; try { arr = r && (!r.exp || r.exp > now) ? JSON.parse(r.v) : []; } catch (e) {}
        const dup = op.dedupe ? arr.find(x => x && Object.entries(op.dedupe).every(([f, v]) => x[f] === v)) : null;
        if (dup) out.push({ dup }); else { arr.unshift(op.item); this.sql.exec("INSERT INTO kv (k,v,exp) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp", op.k, JSON.stringify(arr.slice(0, op.cap || 50)), op.ttl ? now + op.ttl * 1000 : null); out.push({ added: true }); }
      }
      else if (op.o === "jpatch") {
        // Atomic in-place edit of the list elements that match, leaving every other element (including ones added a moment ago) untouched.
        const r = [...this.sql.exec("SELECT v, exp FROM kv WHERE k=?", op.k)][0]; let arr = []; try { arr = r && (!r.exp || r.exp > now) ? JSON.parse(r.v) : []; } catch (e) {}
        let n = 0; for (const x of arr) if (x && Object.entries(op.match || {}).every(([f, v]) => x[f] === v)) { Object.assign(x, op.patch); n++; }
        if (n) this.sql.exec("UPDATE kv SET v=? WHERE k=?", JSON.stringify(arr), op.k);
        out.push({ patched: n });
      }
      else if (op.o === "jappend") {
        // Atomic multi-item append (one Durable Object turn), skipping items whose name+metAt already exist, for the device-to-server people import.
        const r = [...this.sql.exec("SELECT v, exp FROM kv WHERE k=?", op.k)][0]; let arr = []; try { arr = r && (!r.exp || r.exp > now) ? JSON.parse(r.v) : []; } catch (e) {}
        let n = 0; for (const it of op.items || []) { if (arr.some(q => q && q.card && it.card && q.card.name === it.card.name && it.metAt && q.metAt === it.metAt)) continue; arr.push(it); n++; }
        this.sql.exec("INSERT INTO kv (k,v,exp) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", op.k, JSON.stringify(arr.slice(0, op.cap || 500)), r ? r.exp : null); out.push({ added: n, total: Math.min(arr.length, op.cap || 500) });
      }
      else if (op.o === "jdel") {
        // Atomic removal of the list elements that match, leaving elements other requests added a moment ago.
        const r = [...this.sql.exec("SELECT v, exp FROM kv WHERE k=?", op.k)][0]; let arr = []; try { arr = r && (!r.exp || r.exp > now) ? JSON.parse(r.v) : []; } catch (e) {}
        const keep = arr.filter(x => !(x && Object.entries(op.match || {}).every(([f, v]) => x[f] === v)));
        if (keep.length !== arr.length) this.sql.exec("UPDATE kv SET v=? WHERE k=?", JSON.stringify(keep), op.k);
        out.push({ removed: arr.length - keep.length });
      }
      else if (op.o === "jmerge") {
        // Atomic object edit: set or remove only the named top-level fields, leaving fields other requests wrote a moment ago untouched.
        const r = [...this.sql.exec("SELECT v, exp FROM kv WHERE k=?", op.k)][0]; let o = {}; try { o = r && (!r.exp || r.exp > now) ? JSON.parse(r.v) : {}; } catch (e) {}
        Object.assign(o, op.set || {}); for (const f of op.del || []) delete o[f];
        this.sql.exec("INSERT INTO kv (k,v,exp) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", op.k, JSON.stringify(o), r ? r.exp : null); out.push({ merged: true });
      }
      else if (op.o === "list") { out.push([...this.sql.exec("SELECT k FROM kv WHERE k LIKE ? ESCAPE '\\' AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT ?", String(op.prefix).replace(/[\\%_]/g, "\\$&") + "%", now, Math.min(op.limit || 1000, 1000))].map(r => r.k)); }
    }
    return Response.json({ out });
  }
}

// Per-request client with the same get/put/delete/list surface as a KV namespace, plus getMany. Reads are cached for the life of the request;
// writes are buffered and travel with the next read miss or with flush() (called once before the response is returned).
export class BatchedKV {
  constructor(ns, name = "main") { this.stub = ns.get(ns.idFromName(name)); this.cache = new Map(); this.buf = []; this.calls = 0; }
  async _send(ops) { this.calls++; const r = await this.stub.fetch("https://store/batch", { method: "POST", body: JSON.stringify({ ops }) }); return (await r.json()).out; }
  async get(k) { return (await this.getMany([k]))[0]; }
  async getMany(keys) {
    const miss = [...new Set(keys.filter(k => !this.cache.has(k)))];
    if (miss.length || this.buf.length) {
      const ops = this.buf.splice(0).concat(miss.map(k => ({ o: "get", k })));
      const out = await this._send(ops);
      const vals = out.slice(ops.length - miss.length);
      miss.forEach((k, i) => this.cache.set(k, vals[i]));
    }
    return keys.map(k => this.cache.get(k) ?? null);
  }
  async put(k, v, opts) { this.cache.set(k, String(v)); this.buf.push({ o: "put", k, v: String(v), ttl: opts && opts.expirationTtl }); }
  async delete(k) { this.cache.set(k, null); this.buf.push({ o: "del", k }); }
  async list(o) { const ops = this.buf.splice(0).concat([{ o: "list", prefix: (o && o.prefix) || "", limit: o && o.limit }]); const out = await this._send(ops); return { keys: out[out.length - 1].map(name => ({ name })), list_complete: true }; }
  async jpush(k, item, opts = {}) { this.cache.delete(k); const ops = this.buf.splice(0).concat([{ o: "jpush", k, item, dedupe: opts.dedupe, cap: opts.cap, ttl: opts.ttl }]); const out = await this._send(ops); return out[out.length - 1]; }
  async jpatch(k, match, patch) { this.cache.delete(k); const ops = this.buf.splice(0).concat([{ o: "jpatch", k, match, patch }]); const out = await this._send(ops); return out[out.length - 1]; }
  async jmerge(k, set, del) { this.cache.delete(k); const ops = this.buf.splice(0).concat([{ o: "jmerge", k, set, del }]); const out = await this._send(ops); return out[out.length - 1]; }
  async jdel(k, match) { this.cache.delete(k); const ops = this.buf.splice(0).concat([{ o: "jdel", k, match }]); const out = await this._send(ops); return out[out.length - 1]; }
  async jappend(k, items, cap) { this.cache.delete(k); const ops = this.buf.splice(0).concat([{ o: "jappend", k, items, cap }]); const out = await this._send(ops); return out[out.length - 1]; }
  async flush() { if (this.buf.length) await this._send(this.buf.splice(0)); }
}
