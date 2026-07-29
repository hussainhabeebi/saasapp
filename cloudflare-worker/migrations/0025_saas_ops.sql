-- SaaS Ops module (SETUP.md "SaaS Ops module") — subscription/lifecycle tracking, activation,
-- usage/PQL signals, account health scoring, support-ticket signals, CSM touchpoints, NPS/CSAT
-- surveys, competitor battlecards, and renewal/activation reminders for the "SaaS / Digital
-- Marketing" industry (INDUSTRIES.saas_digital_marketing, frontend/dashboard.html).
--
-- Deliberately built on top of the existing Financial Planning module
-- (0015_financial_planning.sql) rather than a second, parallel customer/billing system:
-- fp_customers already is the recurring-billing "Account" record (plan/monthly_value/
-- billing_cycle/status), and fp_expected_dues/fp_collections already is the MRR/collections
-- ledger — Stripe/Chargebee/Paddle webhooks upsert into those same tables instead of a new
-- saas_subscription_events table. fp_config already is the per-client single-row settings table
-- (same shape as marketing_client_settings) — the new billing/support provider credentials below
-- are just more columns on it, not a second settings table.

ALTER TABLE fp_customers ADD COLUMN company_name TEXT;
ALTER TABLE fp_customers ADD COLUMN plan_tier TEXT;
ALTER TABLE fp_customers ADD COLUMN trial_end_date TEXT;
-- onboarding|active|at_risk|renewal|expansion|churned — a second, SaaS-lifecycle-shaped axis
-- alongside the existing generic `status` (active|paused|cancelled), which stays untouched.
ALTER TABLE fp_customers ADD COLUMN lifecycle_stage TEXT;
ALTER TABLE fp_customers ADD COLUMN renewal_date TEXT;
ALTER TABLE fp_customers ADD COLUMN seat_count INTEGER;
ALTER TABLE fp_customers ADD COLUMN health_score INTEGER;
-- 'Yes' locks health_score against the daily recompute cron — same manual-override convention as
-- LEADS.WinProbabilityManual (worker.js).
ALTER TABLE fp_customers ADD COLUMN health_score_manual TEXT;
ALTER TABLE fp_customers ADD COLUMN csm_owner TEXT;

-- Per-client credentials for the client's OWN Stripe/Chargebee/Paddle/support-tool account —
-- same "client pastes their own API key(s)" pattern as accounting_documents' erpnext_base_url/
-- api_key/api_secret (frontend/accounting.html), not a shared Worker-level OAuth app (no live
-- developer accounts for 6 providers exist to register one against).
ALTER TABLE fp_config ADD COLUMN stripe_secret_key TEXT;
ALTER TABLE fp_config ADD COLUMN stripe_webhook_secret TEXT;
ALTER TABLE fp_config ADD COLUMN chargebee_site TEXT;
ALTER TABLE fp_config ADD COLUMN chargebee_api_key TEXT;
ALTER TABLE fp_config ADD COLUMN chargebee_webhook_secret TEXT;
ALTER TABLE fp_config ADD COLUMN paddle_api_key TEXT;
ALTER TABLE fp_config ADD COLUMN paddle_webhook_secret TEXT;
ALTER TABLE fp_config ADD COLUMN support_provider TEXT; -- zendesk|intercom|freshdesk
ALTER TABLE fp_config ADD COLUMN support_api_key TEXT;
ALTER TABLE fp_config ADD COLUMN support_subdomain TEXT;
ALTER TABLE fp_config ADD COLUMN usage_ingest_token TEXT; -- bearer token for handleSaasUsageEvent

-- Product usage / PQL signal ingestion — nothing existing in this app covers real in-product
-- usage events for any industry, so this is genuinely new.
CREATE TABLE IF NOT EXISTS saas_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_usage_events_customer ON saas_usage_events(customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_saas_usage_events_client ON saas_usage_events(client_id, occurred_at);

-- Activation checklist — client-configurable milestone definitions plus per-account completion.
-- Deliberately NOT built on pipeline_followups (0013_pipeline_followups.sql): that table is
-- uniquely keyed one row per lead_id, anchored to pipeline Stage — incompatible with an account
-- needing several independent milestones tracked at once.
CREATE TABLE IF NOT EXISTS saas_activation_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  milestone_key TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_activation_milestones_client ON saas_activation_milestones(client_id);

CREATE TABLE IF NOT EXISTS saas_account_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  milestone_key TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_account_milestones_unique ON saas_account_milestones(customer_id, milestone_key);
CREATE INDEX IF NOT EXISTS idx_saas_account_milestones_client ON saas_account_milestones(client_id);

-- Support-ticket signal rollups — pulled periodically via each provider's REST API (one auth
-- pattern: an API key), not per-ticket webhook ingestion, to avoid three more provider-specific
-- webhook signature schemes to get subtly wrong with no live account to test against.
CREATE TABLE IF NOT EXISTS saas_support_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_id INTEGER,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  avg_csat REAL,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_support_signals_client ON saas_support_signals(client_id, period_start);
CREATE INDEX IF NOT EXISTS idx_saas_support_signals_customer ON saas_support_signals(customer_id, period_start);

CREATE TABLE IF NOT EXISTS saas_touchpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  touchpoint_type TEXT NOT NULL, -- qbr|checkin|escalation
  notes TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_touchpoints_customer ON saas_touchpoints(customer_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_saas_touchpoints_client ON saas_touchpoints(client_id);

CREATE TABLE IF NOT EXISTS saas_surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  survey_type TEXT NOT NULL, -- nps|csat
  score INTEGER,
  comment TEXT,
  sent_at TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_surveys_customer ON saas_surveys(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_saas_surveys_client ON saas_surveys(client_id);

CREATE TABLE IF NOT EXISTS saas_battlecards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  competitor_name TEXT NOT NULL,
  comparison_json TEXT,
  positioning_notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_battlecards_client ON saas_battlecards(client_id);

-- Generic account-anchored reminder — renewal (90/60/30 days before renewal_date) and
-- activation-milestone-miss nudges. pipeline_followups couldn't be reused for this (see comment
-- above); this table can hold several independent reminder rows per account at once.
CREATE TABLE IF NOT EXISTS saas_account_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  reminder_type TEXT NOT NULL, -- renewal_90|renewal_60|renewal_30|milestone_miss
  anchor_at TEXT NOT NULL,
  offset_days INTEGER NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_account_reminders_unique ON saas_account_reminders(customer_id, reminder_type, anchor_at);
CREATE INDEX IF NOT EXISTS idx_saas_account_reminders_client ON saas_account_reminders(client_id, sent_at);
