-- Live Agency default currency + live exchange rates (see live-travel-fx.js).
-- The FX columns on live_travel_offers / _quotes / _bookings (supplier_currency, supplier_total,
-- fx_rate, fx_rate_at, fx_source, fx_status, fx_buffer_pct) are added at runtime by
-- ltEnsureSchema with ignore-if-exists ALTERs, matching how hold_ref/checkout_url were added,
-- so this migration stays idempotent on databases where the worker already ran.

CREATE TABLE IF NOT EXISTS live_travel_currency_settings (
  client_id INTEGER PRIMARY KEY,
  default_currency TEXT NOT NULL DEFAULT 'AED',
  fx_buffer_pct REAL NOT NULL DEFAULT 1.5,
  rounding TEXT NOT NULL DEFAULT 'auto',
  allow_currency_override INTEGER NOT NULL DEFAULT 1,
  auto_detect_phone_currency INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per base currency (always 'USD'); rates_json holds {CODE: units per 1 USD}.
CREATE TABLE IF NOT EXISTS live_travel_fx_rates (
  base TEXT PRIMARY KEY,
  rates_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL
);
