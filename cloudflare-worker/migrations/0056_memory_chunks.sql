-- Semantic memory (Tier 2, SETUP.md "Conversation Engine" -> "Semantic memory") — holds the full
-- text for every chunk indexed into Cloudflare Vectorize (MEMORY_INDEX binding, wrangler.toml).
-- Vectorize itself only stores a vector + small metadata per entry, not full text reliably, so this
-- table is the source of truth for the actual content; Vectorize's vector id === this table's id
-- (a UUID, generated in worker.js), letting a query's top-K matches map straight back to a row here.
-- kind distinguishes what's embedded: 'conversation' (one customer+bot exchange, lead_id set),
-- 'product' (one catalog product, ref_id = NocoDB product Id, lead_id NULL — shared across every
-- customer of this client), 'category' (one ecom_categories row, ref_id = its id, lead_id NULL).
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,          -- UUID, shared with the Vectorize vector id
  client_id INTEGER NOT NULL,
  lead_id INTEGER,              -- NULL for client-wide content (product/category), set for conversation turns
  kind TEXT NOT NULL,           -- 'conversation' | 'product' | 'category'
  ref_id TEXT,                  -- product/category id this chunk describes, when applicable
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_client ON memory_chunks(client_id, kind);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_lead ON memory_chunks(lead_id);
