-- B2B Current Stock — uploaded via frontend/b2b.html "Current Stock" tab, one row per client.
-- Moved from a NocoDB LongText column (b2b_stock_json on the CLIENTS table) to D1 for reliable
-- cross-session persistence: NocoDB PATCH on large JSON fields was silently failing, so the data
-- was lost on every new login.  The bot engine reads this table at the start of handleEngineWebhook
-- and attaches it to the client record before engineBuildFaqSystemPrompt runs.
CREATE TABLE IF NOT EXISTS b2b_stock (
  client_id INTEGER PRIMARY KEY,
  stock_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
