-- Hospitality Pro module (cloudflare-worker/hospitality-pro.js, dashboard "🏨 Hospitality → ⭐ Pro").
-- An add-on on top of the Hospitality module, active only for clients with BOTH
-- CLIENTS.hospitality_enabled='Yes' AND CLIENTS.hospitality_pro_enabled='Yes'.
--
-- Purely additive: every table below is new and nothing here alters an existing hospitality_*
-- table. Holds live in their own table (hosp_pro_holds) rather than as a new
-- hospitality_bookings.status value, so the existing overlap check, availability calendar and
-- /hospitality/stats occupancy maths keep working exactly as before. A hold only becomes a real
-- hospitality_bookings row (status 'confirmed') once it's paid / confirmed by staff.

-- Per-client Pro settings. config_json holds the non-secret knobs (feature toggles, hold length,
-- deposit %, loyalty discounts, recovery timing…) — see HP_DEFAULT_CONFIG in hospitality-pro.js.
-- Razorpay credentials sit in their own columns and are never returned to the browser.
CREATE TABLE IF NOT EXISTS hosp_pro_settings (
  client_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL DEFAULT '{}',
  razorpay_key_id TEXT,
  razorpay_key_secret TEXT,
  razorpay_webhook_secret TEXT,
  updated_at TEXT NOT NULL
);

-- Upsells offered during the WhatsApp quote (candlelight dinner, campfire, airport pickup…).
-- price_type: per_booking | per_night | per_guest | per_guest_night.
CREATE TABLE IF NOT EXISTS hosp_pro_addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  price_type TEXT NOT NULL DEFAULT 'per_booking',
  currency TEXT NOT NULL DEFAULT 'INR',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_addons_client ON hosp_pro_addons(client_id);

-- Virtual tour links (360° tour, YouTube walkthrough, Instagram reel…) shown before the price.
-- Attached to a unit, a resort property, or neither (= whole-resort tour).
CREATE TABLE IF NOT EXISTS hosp_pro_tours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER,
  property_id INTEGER,
  title TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_tours_client ON hosp_pro_tours(client_id);

-- Per-lead conversation state for the Pro WhatsApp flows (quote / group / registration). Kept in
-- D1 rather than as new NocoDB lead columns so the module never touches the leads table schema.
CREATE TABLE IF NOT EXISTS hosp_pro_state (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id)
);

-- "Hold this room" — a priced quote reserved for hold_minutes while the guest pays the deposit.
-- status: active | payment_claimed | converted | expired | released | conflict.
CREATE TABLE IF NOT EXISTS hosp_pro_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  lead_id INTEGER,
  conv_id TEXT,
  guest_name TEXT NOT NULL DEFAULT '',
  guest_phone TEXT NOT NULL DEFAULT '',
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  nights INTEGER NOT NULL DEFAULT 1,
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  room_total REAL NOT NULL DEFAULT 0,
  discount_label TEXT NOT NULL DEFAULT '',
  discount_amount REAL NOT NULL DEFAULT 0,
  addons_json TEXT NOT NULL DEFAULT '[]',
  addons_total REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  deposit_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  payment_url TEXT,
  payment_link_id TEXT,
  payment_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT NOT NULL,
  expiry_notified INTEGER NOT NULL DEFAULT 0,
  booking_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_holds_client ON hosp_pro_holds(client_id, status);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_holds_unit ON hosp_pro_holds(unit_id, status);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_holds_lead ON hosp_pro_holds(lead_id, status);

-- Digital guest registration — ID photos collected on WhatsApp after a booking is confirmed.
-- documents_json is an array of {url, at}. status: pending | received | verified.
CREATE TABLE IF NOT EXISTS hosp_pro_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER,
  lead_id INTEGER,
  guest_name TEXT NOT NULL DEFAULT '',
  guest_phone TEXT NOT NULL DEFAULT '',
  documents_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_reg_client ON hosp_pro_registrations(client_id, status);

-- Group & event enquiries (weddings, corporate offsites, college tours, large families).
-- status: new | quoted | won | lost.
CREATE TABLE IF NOT EXISTS hosp_pro_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER,
  conv_id TEXT,
  guest_name TEXT NOT NULL DEFAULT '',
  guest_phone TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT '',
  group_size INTEGER NOT NULL DEFAULT 0,
  check_in TEXT,
  check_out TEXT,
  requirements TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_groups_client ON hosp_pro_groups(client_id, status);

-- Abandoned-inquiry recovery — one row per lead that was shown a quote but didn't hold.
-- status: active | held | converted | stopped | done. step = how many nudges were already sent.
CREATE TABLE IF NOT EXISTS hosp_pro_recovery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  conv_id TEXT,
  guest_name TEXT NOT NULL DEFAULT '',
  unit_id INTEGER,
  check_in TEXT,
  check_out TEXT,
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  quoted_total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  step INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT NOT NULL,
  last_sent_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_pro_recovery_lead ON hosp_pro_recovery(client_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_hosp_pro_recovery_status ON hosp_pro_recovery(status);
