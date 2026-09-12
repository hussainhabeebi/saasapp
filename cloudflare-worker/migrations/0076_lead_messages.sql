-- D1 storage for individual lead conversation messages.
-- Replaces the ConvHistory JSON blob on NocoDB leads for the chats UI:
-- reads are fast indexed queries instead of fetching a full lead record,
-- writes are single INSERTs instead of re-serialising the entire array.
-- The engine still dual-writes ConvHistory to NocoDB for bot context;
-- this table is the display truth for chats.html.
CREATE TABLE IF NOT EXISTS lead_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL,
  client_id   INTEGER NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT    NOT NULL DEFAULT '',
  attachment  TEXT    NOT NULL DEFAULT '{}',
  reply_to    TEXT    NOT NULL DEFAULT '{}',
  ts          TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Composite UNIQUE prevents duplicate inserts on webhook replays.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lm_dedup
  ON lead_messages(lead_id, ts, role);

CREATE INDEX IF NOT EXISTS idx_lm_lead_ts
  ON lead_messages(lead_id, ts);

CREATE INDEX IF NOT EXISTS idx_lm_client
  ON lead_messages(client_id, ts);
