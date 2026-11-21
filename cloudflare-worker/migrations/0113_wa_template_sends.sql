-- One row per WhatsApp template successfully handed to Meta (directly or via Chatwoot), from any
-- feature — read by GET /billing/usage for the Billing page's "Usage This Month" card.
-- The Worker also creates this itself on first use (waTemplateSendsEnsureSchema), so applying this
-- file is optional; it's here so `wrangler d1 migrations apply` leaves the database in the same shape.
CREATE TABLE IF NOT EXISTS wa_template_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  source TEXT NOT NULL,                     -- manual | broadcast | followup | automation | calendar | monthly_marketing | shopify | meetings | hot_alert | lead_ad | support | payment_reminder | appointments | ceo_bot
  template_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',           -- digits only; blank when sent via a Chatwoot conversation
  lead_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_template_sends_client_time ON wa_template_sends(client_id, created_at);
