// D1-backed storage for Tagg (branch-only, not deployed). Exposes the same surface the app already uses on its KV
// namespace (get/getMany/put/delete/list), plus the atomic JSON list/object operations (jpush/jpatch/jmerge) via
// optimistic compare-and-swap with bounded retries.
//
// Why D1: Workers KV Free allows 1,000 writes/day account-wide. D1 Free allows 100,000 rows written and
// 5,000,000 rows read per day (developers.cloudflare.com/d1/platform/pricing/), so real launch traffic fits.
//
// Table (worker/schema-d1.sql): kv(k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER) - exp is epoch ms, NULL = never.
// Expiry semantics differ from KV: KV expires keys on its own for free; here expired rows are filtered at read time
// and physically removed by a sweep (deletes count as rows written, so the sweep is deliberately infrequent).
//
// Rows-read note: every query here is a primary-key lookup or a bounded prefix scan on the primary key, so one key
// read costs one row read - the 5M rows/day allowance is not eroded by scans.

export class D1KV {
  constructor(db, opts = {}) {
    this.db = db;
    this.mirror = opts.mirror || null; // original KV namespace; transition-only write mirror
    this.cache = new Map();            // per-request coherence: reads see this request's own buffered writes
    this.buf = [];                     // buffered put/delete ops: { k, v|null, ttl }
    this.calls = 0;                    // D1 queries issued (free tier: 50 per Worker invocation)
  }

  // Flush buffered writes, optionally followed by extra statements, in one atomic batch.
  async _flushBuf(extra = []) {
    if (!this.buf.length && !extra.length) return null;
    const ops = this.buf.splice(0);
    const stmts = ops.map(o => o.v === null
      ? this.db.prepare("DELETE FROM kv WHERE k=?1").bind(o.k)
      : this.db.prepare("INSERT INTO kv (k,v,exp) VALUES (?1,?2,?3) ON CONFLICT(k) DO UPDATE SET v=excluded.v, exp=excluded.exp")
          .bind(o.k, o.v, o.ttl ? Date.now() + o.ttl * 1000 : null)
    ).concat(extra);
    this.calls += stmts.length;
    const res = await this.db.batch(stmts);
    if (this.mirror) for (const o of ops) {
      try { o.v === null ? await this.mirror.delete(o.k) : await this.mirror.put(o.k, o.v, o.ttl ? { expirationTtl: o.ttl } : undefined); }
      catch (e) { /* mirror is best-effort during transition; D1 stays the source of truth */ }
    }
    return res;
  }

  async get(k) { return (await this.getMany([k]))[0]; }

  async getMany(keys) {
    const miss = [...new Set(keys.filter(k => !this.cache.has(k)))];
    if (miss.length || this.buf.length) {
      // One IN query covers all misses (D1 allows 100 bound parameters per query; call sites stay well under).
      const sel = miss.length
        ? [this.db.prepare("SELECT k, v, exp FROM kv WHERE k IN (" + miss.map((_, i) => "?" + (i + 1)).join(",") + ")").bind(...miss)]
        : [];
      const flushed = await this._flushBuf(sel);
      if (miss.length) {
        const rows = (flushed && flushed[flushed.length - 1].results) || [];
        const now = Date.now(), found = new Map();
        for (const r of rows) if (!r.exp || r.exp > now) found.set(r.k, r.v);
        for (const k of miss) this.cache.set(k, found.get(k) ?? null);
      }
    }
    return keys.map(k => this.cache.get(k) ?? null);
  }

  async put(k, v, opts) { this.cache.set(k, String(v)); this.buf.push({ k, v: String(v), ttl: opts && opts.expirationTtl }); }
  async delete(k) { this.cache.set(k, null); this.buf.push({ k, v: null }); }

  async list(o) {
    await this._flushBuf();
    this.calls++;
    const r = await this.db.prepare(
      "SELECT k FROM kv WHERE k LIKE ?1 ESCAPE '\\' AND (exp IS NULL OR exp > ?2) ORDER BY k LIMIT ?3"
    ).bind(String((o && o.prefix) || "").replace(/[\\%_]/g, "\\$&") + "%", Date.now(), Math.min((o && o.limit) || 1000, 1000)).all();
    return { keys: (r.results || []).map(row => ({ name: row.k })), list_complete: true };
  }

  // Atomic read-modify-write on one key: mutate(oldRawValue) returns { value, result } to write, or { skip: result }.
  // Compare-and-swap: the UPDATE only lands if the stored value is still what we read; on a lost race we re-read and retry.
  async _cas(k, mutate, ttl) {
    await this._flushBuf();
    for (let attempt = 0; attempt < 4; attempt++) {
      this.calls++;
      const row = await this.db.prepare("SELECT v, exp FROM kv WHERE k=?1").bind(k).first();
      const now = Date.now();
      const live = row && (!row.exp || row.exp > now);
      const oldRaw = live ? row.v : null;
      const next = mutate(oldRaw);
      if (next.skip) return next.result;
      const exp = ttl ? now + ttl * 1000 : (row ? row.exp : null);
      this.calls++;
      const r = row === null
        ? await this.db.prepare("INSERT INTO kv (k,v,exp) VALUES (?1,?2,?3) ON CONFLICT(k) DO NOTHING").bind(k, next.value, exp).run()
        : await this.db.prepare("UPDATE kv SET v=?2, exp=?3 WHERE k=?1 AND v=?4").bind(k, next.value, exp, row.v).run();
      if (r.meta && r.meta.changes > 0) {
        this.cache.set(k, next.value);
        if (this.mirror) { try { await this.mirror.put(k, next.value, ttl ? { expirationTtl: ttl } : undefined); } catch (e) {} }
        return next.result;
      }
    }
    throw new Error("storage contention on " + k);
  }

  // Prepend to a JSON array with de-duplication and a cap, atomically (concurrent connects cannot overwrite each other).
  async jpush(k, item, opts = {}) {
    return this._cas(k, (oldRaw) => {
      let arr = []; try { arr = oldRaw ? JSON.parse(oldRaw) : []; } catch (e) {}
      const dup = opts.dedupe ? arr.find(x => x && Object.entries(opts.dedupe).every(([f, v]) => x[f] === v)) : null;
      if (dup) return { skip: true, result: { dup } };
      arr.unshift(item);
      return { value: JSON.stringify(arr.slice(0, opts.cap || 50)), result: { added: true } };
    }, opts.ttl);
  }

  // Patch every array element matching `match`, atomically. Elements other requests added a moment ago are untouched.
  async jpatch(k, match, patch) {
    return this._cas(k, (oldRaw) => {
      let arr = []; try { arr = oldRaw ? JSON.parse(oldRaw) : []; } catch (e) {}
      let n = 0;
      for (const x of arr) if (x && Object.entries(match || {}).every(([f, v]) => x[f] === v)) { Object.assign(x, patch); n++; }
      if (!n) return { skip: true, result: { patched: 0 } };
      return { value: JSON.stringify(arr), result: { patched: n } };
    });
  }

  // Set or remove only the named top-level fields of a JSON object, atomically.
  async jmerge(k, set, del) {
    return this._cas(k, (oldRaw) => {
      let o = {}; try { o = oldRaw ? JSON.parse(oldRaw) : {}; } catch (e) {}
      Object.assign(o, set || {}); for (const f of del || []) delete o[f];
      return { value: JSON.stringify(o), result: { merged: true } };
    });
  }

  async flush() { await this._flushBuf(); }
}
