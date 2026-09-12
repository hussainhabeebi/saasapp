-- Standalone Live Travel Agency. All rows are tenant-scoped by client_id and are
-- intentionally independent from the legacy ta_* NocoDB tables.

CREATE TABLE IF NOT EXISTS live_travel_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  agent_ref TEXT NOT NULL,
  parent_agent_ref TEXT NOT NULL DEFAULT 'owner',
  agent_type TEXT NOT NULL DEFAULT 'agent',
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  credit_limit REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, agent_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_agents_client
  ON live_travel_agents(client_id, parent_agent_ref, status);

CREATE TABLE IF NOT EXISTS live_travel_suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  supplier TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'sandbox',
  priority INTEGER NOT NULL DEFAULT 100,
  markup_type TEXT NOT NULL DEFAULT 'fixed',
  markup_value REAL NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT 'not_configured',
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  credentials_encrypted TEXT,
  endpoints_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(client_id, supplier)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_suppliers_client
  ON live_travel_suppliers(client_id, enabled, priority);

CREATE TABLE IF NOT EXISTS live_travel_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  search_ref TEXT NOT NULL,
  lead_id TEXT NOT NULL DEFAULT '',
  trip_type TEXT NOT NULL DEFAULT 'round_trip',
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_date TEXT NOT NULL,
  return_date TEXT,
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  infants INTEGER NOT NULL DEFAULT 0,
  cabin TEXT NOT NULL DEFAULT 'economy',
  currency TEXT NOT NULL DEFAULT 'AED',
  status TEXT NOT NULL DEFAULT 'searching',
  supplier_errors_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(client_id, search_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_searches_client
  ON live_travel_searches(client_id, created_at);

CREATE TABLE IF NOT EXISTS live_travel_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  search_id INTEGER NOT NULL,
  offer_ref TEXT NOT NULL,
  supplier TEXT NOT NULL,
  supplier_offer_id TEXT NOT NULL DEFAULT '',
  bookable INTEGER NOT NULL DEFAULT 0,
  validating INTEGER NOT NULL DEFAULT 0,
  validating_supplier TEXT NOT NULL DEFAULT '',
  airline_code TEXT NOT NULL DEFAULT '',
  airline_name TEXT NOT NULL DEFAULT '',
  flight_numbers TEXT NOT NULL DEFAULT '',
  itinerary_json TEXT NOT NULL DEFAULT '[]',
  baggage_json TEXT NOT NULL DEFAULT '{}',
  fare_rules_json TEXT NOT NULL DEFAULT '{}',
  cabin TEXT NOT NULL DEFAULT 'economy',
  seats_left INTEGER,
  currency TEXT NOT NULL DEFAULT 'AED',
  base_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  markup_amount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  last_validated_at TEXT,
  expires_at TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(client_id, offer_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_offers_search
  ON live_travel_offers(client_id, search_id, total_amount);

CREATE TABLE IF NOT EXISTS live_travel_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  quote_ref TEXT NOT NULL,
  search_id INTEGER,
  offer_id INTEGER,
  lead_id TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT NOT NULL DEFAULT 'AED',
  subtotal REAL NOT NULL DEFAULT 0,
  service_fee REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  valid_until TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, quote_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_quotes_client
  ON live_travel_quotes(client_id, status, updated_at);

CREATE TABLE IF NOT EXISTS live_travel_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_ref TEXT NOT NULL,
  quote_id INTEGER,
  offer_id INTEGER,
  lead_id TEXT NOT NULL DEFAULT '',
  supplier TEXT NOT NULL DEFAULT '',
  supplier_booking_id TEXT NOT NULL DEFAULT '',
  pnr TEXT NOT NULL DEFAULT '',
  ticket_numbers_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  currency TEXT NOT NULL DEFAULT 'AED',
  total_amount REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  balance_due REAL NOT NULL DEFAULT 0,
  hold_expires_at TEXT,
  last_synced_at TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, booking_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_bookings_client
  ON live_travel_bookings(client_id, status, updated_at);

CREATE TABLE IF NOT EXISTS live_travel_passengers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  passenger_type TEXT NOT NULL DEFAULT 'adult',
  title TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth TEXT,
  gender TEXT NOT NULL DEFAULT '',
  nationality TEXT NOT NULL DEFAULT '',
  passport_number TEXT NOT NULL DEFAULT '',
  passport_expiry TEXT,
  issuing_country TEXT NOT NULL DEFAULT '',
  frequent_flyer_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_travel_passengers_booking
  ON live_travel_passengers(client_id, booking_id);

CREATE TABLE IF NOT EXISTS live_travel_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  payment_ref TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  direction TEXT NOT NULL DEFAULT 'receipt',
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'AED',
  status TEXT NOT NULL DEFAULT 'received',
  external_ref TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(client_id, payment_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_payments_booking
  ON live_travel_payments(client_id, booking_id, created_at);

CREATE TABLE IF NOT EXISTS live_travel_wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  entry_ref TEXT NOT NULL,
  agent_ref TEXT NOT NULL DEFAULT 'owner',
  booking_id INTEGER,
  entry_type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'AED',
  balance_after REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(client_id, entry_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_wallet_client
  ON live_travel_wallet_ledger(client_id, agent_ref, created_at);

CREATE TABLE IF NOT EXISTS live_travel_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  agent_ref TEXT NOT NULL DEFAULT 'owner',
  commission_type TEXT NOT NULL DEFAULT 'fixed',
  commission_value REAL NOT NULL DEFAULT 0,
  commission_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_travel_commissions_client
  ON live_travel_commissions(client_id, status, created_at);

CREATE TABLE IF NOT EXISTS live_travel_service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  request_ref TEXT NOT NULL,
  booking_id INTEGER NOT NULL,
  request_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT NOT NULL DEFAULT '',
  supplier_reference TEXT NOT NULL DEFAULT '',
  estimated_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(client_id, request_ref)
);
CREATE INDEX IF NOT EXISTS idx_live_travel_service_requests_client
  ON live_travel_service_requests(client_id, status, updated_at);

CREATE TABLE IF NOT EXISTS live_travel_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_email TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_travel_audit_client
  ON live_travel_audit_log(client_id, created_at);
