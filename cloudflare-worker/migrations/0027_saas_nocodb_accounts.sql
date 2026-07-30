-- SaaS Ops v2 (SETUP.md "SaaS Ops module") — the client's OWN NocoDB customers table is the
-- account system of record (confirmed with the user explicitly: their NocoDB table holds real,
-- live SaaS customers and must not be conflated with fp_customers/ERPNext). This migration adds
-- SaaS Ops' own settings table (split out of fp_config — Financial Planning's own table, kept
-- fully separate) and a dedicated revenue ledger, replacing fp_customers/fp_expected_dues/
-- fp_collections for this module. saas_activation_milestones/saas_account_milestones/
-- saas_touchpoints/saas_surveys/saas_battlecards/saas_account_reminders/saas_usage_events/
-- saas_support_signals (migration 0025) need no schema change here — their existing
-- `customer_id INTEGER` columns now hold a NocoDB row Id (also a plain integer) instead of an
-- fp_customers.id; only the backend code's meaning of that column changes, not its shape.
--
-- Computed fields the module itself owns (health score, lifecycle stage, etc.) are written
-- directly onto the client's NocoDB customer rows as new `saas_`-prefixed columns
-- (ensureSaasCustomerFields, worker.js — same auto-provisioning pattern as
-- ensureEcomProductStyleFields) rather than living in a D1 shadow table — deliberately so the
-- client's own live customer record reflects the real computed state. This app never writes to
-- any NocoDB column it didn't create itself.

CREATE TABLE IF NOT EXISTS saas_config (
  client_id INTEGER PRIMARY KEY,
  nocodb_customers_table_id TEXT,
  stripe_secret_key TEXT,
  stripe_webhook_secret TEXT,
  chargebee_site TEXT,
  chargebee_api_key TEXT,
  chargebee_webhook_secret TEXT,
  paddle_api_key TEXT,
  paddle_webhook_secret TEXT,
  support_provider TEXT,
  support_api_key TEXT,
  support_subdomain TEXT,
  usage_ingest_token TEXT,
  updated_at TEXT NOT NULL
);

-- One row per payment received (from a billing webhook) — this app never proactively generates a
-- "due" of its own for SaaS Ops the way Financial Planning's fp_expected_dues does; every SaaS
-- billing event already originates from a provider telling us a charge succeeded, so a plain
-- collections ledger is sufficient for MRR/revenue-trend/churn reporting.
CREATE TABLE IF NOT EXISTS saas_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  nocodb_customer_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saas_collections_client ON saas_collections(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_saas_collections_customer ON saas_collections(nocodb_customer_id);

-- A billing webhook event whose customer email/phone didn't match any row in the client's
-- configured NocoDB customers table. Never blind-written into that live table on a guess —
-- surfaced here for manual reconciliation (link it to a real customer by hand) in the SaaS Ops
-- Unmatched Events view instead.
CREATE TABLE IF NOT EXISTS saas_unmatched_billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  customer_email TEXT,
  customer_name TEXT,
  plan_name TEXT,
  amount REAL,
  currency TEXT,
  raw_payload TEXT,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_nocodb_customer_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_saas_unmatched_client ON saas_unmatched_billing_events(client_id, resolved_at);
