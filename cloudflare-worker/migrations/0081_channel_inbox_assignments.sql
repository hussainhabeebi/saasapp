-- Per-inbox exclusive agent assignment
CREATE TABLE IF NOT EXISTS channel_inbox_assignments (
  client_id INTEGER NOT NULL,
  inbox_id INTEGER NOT NULL,
  assigned_email TEXT NOT NULL DEFAULT '',
  chatwoot_user_id INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, inbox_id)
);
