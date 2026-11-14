-- Proposals sent from Chats → 📑 AI Proposal (product-catalog.js). Sending one moves the lead to
-- "Proposal Sent" (proposal_sent); Follow-up V3 then sends only its proposal templates
-- (lv_followup_p1/p2/p3, day 1/3/7 after the latest proposal or the customer's reply since) and
-- every other follow-up sender skips the lead. Also created on first use by pcEnsureSchema.
CREATE TABLE IF NOT EXISTS pc_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  total REAL,
  currency TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]',
  pdf_name TEXT NOT NULL DEFAULT '',
  sent_by TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_proposals_lead ON pc_proposals(client_id, lead_id, sent_at);
