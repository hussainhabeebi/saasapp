-- Support tickets for won/converted leads (after-sales support).
-- Created automatically when a won/converted lead sends a new message via WhatsApp.
-- Multiple messages on the same open ticket are appended without creating a new ticket.
-- Resolving a ticket triggers a WhatsApp template message to the customer.
CREATE TABLE IF NOT EXISTS support_tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id       INTEGER NOT NULL,
  lead_id         TEXT    NOT NULL DEFAULT '',
  ref_number      TEXT    NOT NULL DEFAULT '',
  phone           TEXT    NOT NULL,
  customer_name   TEXT,
  source_message  TEXT,                            -- first message that opened the ticket
  messages        TEXT    NOT NULL DEFAULT '[]',   -- JSON array of {text, ts} appended on each customer message
  conv_id         TEXT,
  status          TEXT    NOT NULL DEFAULT 'open', -- open | in_progress | resolved | closed
  assigned_to     TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_client ON support_tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_phone  ON support_tickets(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(client_id, status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_lead   ON support_tickets(client_id, lead_id);
