-- Chats v2 inbox read model (docs/chats-v2-design.md, cloudflare-worker/chats-v2.js).
-- The Worker also creates all of this itself on first use (chatsV2Ready), so applying this file is
-- optional; it's here so `wrangler d1 migrations apply` leaves the database in the same shape.
CREATE TABLE IF NOT EXISTS conversations (
  lead_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  conv_id TEXT NOT NULL DEFAULT '',
  inbox_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  snoozed_until TEXT,
  handover TEXT NOT NULL DEFAULT 'No',
  handover_by TEXT NOT NULL DEFAULT '',
  assignee_email TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '',
  labels_key TEXT NOT NULL DEFAULT ',',
  pinned INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_read_at TEXT,
  last_message_id INTEGER,
  last_message_at TEXT NOT NULL,
  last_message_preview TEXT NOT NULL DEFAULT '',
  last_message_dir TEXT NOT NULL DEFAULT 'in',
  last_sender TEXT NOT NULL DEFAULT '',
  last_customer_at TEXT,
  waiting_since TEXT,
  synced INTEGER NOT NULL DEFAULT 0,
  media_backfilled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_conv_recent ON conversations(client_id, pinned, last_message_at DESC, lead_id DESC);
CREATE INDEX IF NOT EXISTS ix_conv_status ON conversations(client_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ix_conv_assignee ON conversations(client_id, assignee_email, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ix_conv_waiting ON conversations(client_id, waiting_since) WHERE waiting_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_conv_updated ON conversations(client_id, updated_at);

CREATE TABLE IF NOT EXISTS canned_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  shortcut TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, shortcut)
);

CREATE TABLE IF NOT EXISTS chat_sync_state (
  client_id INTEGER PRIMARY KEY,
  backfilled_at TEXT,
  reconciled_at TEXT
);

ALTER TABLE lead_messages ADD COLUMN sender_type TEXT NOT NULL DEFAULT '';
ALTER TABLE lead_messages ADD COLUMN sender_email TEXT NOT NULL DEFAULT '';
ALTER TABLE lead_messages ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
ALTER TABLE lead_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE lead_messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
