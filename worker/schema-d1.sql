-- Tagg D1 schema. One key-value table mirroring the KV data model (string key, string value, optional expiry in epoch ms).
-- Apply with: npx wrangler d1 execute tagg-store --file=worker/schema-d1.sql
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER);
