-- Review Request module + Referral tracking — see SETUP.md for both modules' full description.
-- Applied via: wrangler d1 migrations apply leadvyne-d1 (remote: add --remote).
-- Everything here is sidecar/event-log data keyed by NocoDB's own Lead/Client ids (ClientId,
-- lead_id) — Stage, DealValue, Name, Phone, ClosedAt etc. all stay in NocoDB, which is still the
-- system of record for the lead itself. D1 only holds the data these two modules invented that
-- has no other reader in the app (unlike Country/CompanyName, which every existing lead view
-- already reads out of NocoDB, so those stayed there).

-- Review Request module — one row per client, its on/off toggle + settings.
CREATE TABLE IF NOT EXISTS review_config (
  client_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  stages_json TEXT NOT NULL DEFAULT '[]',
  delay_hours INTEGER NOT NULL DEFAULT 72,
  message TEXT
);

-- Review Request module — one row per lead a request has ever been sent to (or is due for).
-- lead_id is the primary key rather than an autoincrement id since "has this lead already been
-- asked" is the only lookup this table ever needs — a natural key, no surrogate id required.
CREATE TABLE IF NOT EXISTS review_requests (
  lead_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  requested_at TEXT,
  clicked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_requests_client ON review_requests(client_id);

-- Referral tracking — one row per lead that has ever generated its own shareable referral code
-- (via the dashboard's "Get Referral Link" button). Never regenerated once created.
CREATE TABLE IF NOT EXISTS referral_codes (
  lead_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- A code only needs to be unique within one client (engineDetectReferral always scopes its
-- lookup by client_id too), not globally — two different clients' customers coincidentally
-- generating the same short code is fine and expected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_codes_client_code ON referral_codes(client_id, code);

-- Referral tracking — one row per successful referral (a brand-new lead's first message carried
-- a valid code). referred_lead_id is UNIQUE: a lead can only ever be credited to the first code
-- that referred them in, matching the "first message only" detection window in worker.js.
-- reward_status is per referral event (not per referrer), so a referrer who brings in five
-- people can have each one individually marked rewarded.
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  referrer_lead_id INTEGER NOT NULL,
  referred_lead_id INTEGER NOT NULL,
  referred_at TEXT NOT NULL,
  reward_status TEXT NOT NULL DEFAULT 'Pending'
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(client_id, referrer_lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_lead_id);
