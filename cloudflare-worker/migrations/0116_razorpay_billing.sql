-- Razorpay subscriptions for Indian customers + a shared billing event log (razorpay-billing.js).
-- rzp_plans maps each Razorpay Plan to the same Leadvyne plan tier (PLAN_TIERS in worker.js) the
-- Stripe prices sell, so a customer gets the same plan whichever gateway they pay through. Admin →
-- Billing → "Razorpay plans" can import them straight from the Stripe INR prices.
-- billing_events is the audit log behind Admin → "API & Webhooks": every Stripe and Razorpay
-- webhook, plus admin actions (manual plan, cancel, pause…). event_id dedupes redelivered webhooks.
-- razorpay-billing.js also creates both tables lazily, so a deploy that hasn't run this still works.
CREATE TABLE IF NOT EXISTS rzp_plans (
  plan_id TEXT PRIMARY KEY,
  plan_tier TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  period TEXT NOT NULL,
  interval_count INTEGER NOT NULL DEFAULT 1,
  stripe_price_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT,
  event_type TEXT NOT NULL,
  client_id INTEGER,
  object_id TEXT,
  amount INTEGER,
  currency TEXT,
  status TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_dedupe ON billing_events(provider, event_id);
CREATE INDEX IF NOT EXISTS idx_billing_events_client ON billing_events(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_created ON billing_events(created_at);
