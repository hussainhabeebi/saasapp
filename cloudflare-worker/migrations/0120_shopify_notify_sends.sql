-- One row per Shopify order notification attempt (WhatsApp template sent through Chatwoot) —
-- Ecom → 🔔 Notifications. status: sent | delivered | read | failed | pending (template awaiting
-- Meta approval) | skipped (no phone / no template / Chatwoot not connected). Delivery status is
-- refreshed from the Chatwoot message. The Worker also creates this itself on first use
-- (shopify-notify.js ensureSchema), so applying this file is optional.
CREATE TABLE IF NOT EXISTS shopify_notify_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- received | paid | shipped | delivered | abandoned
  order_ref TEXT NOT NULL DEFAULT '',        -- Shopify order id / checkout token (dedupe key)
  order_name TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',            -- WhatsApp number, digits with country code
  template_name TEXT NOT NULL DEFAULT '',
  template_lang TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '[]',    -- variable values, for Retry
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  conv_id TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shopify_notify_client_time ON shopify_notify_sends(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_shopify_notify_order ON shopify_notify_sends(client_id, kind, order_ref);
