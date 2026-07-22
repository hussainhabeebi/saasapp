-- Hospitality module (houseboats/hotels/tourism stays — frontend/dashboard.html "🏨 Hospitality"
-- nav tab, gated by CLIENTS.hospitality_enabled same as ta_enabled/recruit_enabled/appt_enabled).
-- Unlike the Agency/Recruit/Appointments modules (per-client dynamic NocoDB tables through the
-- generic /nocodb/* passthrough), this one is fully D1 — a genuinely new data shape (date-range
-- availability + occupancy pricing) with no NocoDB view anywhere already reading it, so there's no
-- reason to pay NocoDB's per-client-table-creation overhead for it.

-- Unit/room types (a houseboat's "AC Deluxe" vs "Non-AC Standard", or a hotel's room categories).
CREATE TABLE IF NOT EXISTS hospitality_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  unit_type TEXT NOT NULL DEFAULT '',
  capacity_adults INTEGER NOT NULL DEFAULT 2,
  capacity_children INTEGER NOT NULL DEFAULT 0,
  amenities TEXT NOT NULL DEFAULT '',
  base_rate REAL NOT NULL DEFAULT 0,
  weekend_rate REAL,
  currency TEXT NOT NULL DEFAULT 'INR',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_units_client ON hospitality_units(client_id);

-- Manually blocked dates per unit (maintenance, owner-blocked, etc.) — availability is otherwise
-- "open unless a confirmed/checked_in booking or a row here says no", not a dense per-date table
-- pre-populated for the whole future.
CREATE TABLE IF NOT EXISTS hospitality_blocked_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_blocked_unique ON hospitality_blocked_dates(unit_id, date);
CREATE INDEX IF NOT EXISTS idx_hosp_blocked_client ON hospitality_blocked_dates(client_id);

-- Per-date price overrides (peak season, festival, weekend-specific pricing beyond the unit's own
-- flat weekend_rate) — sparse, only for dates that differ from the unit's base/weekend rate.
CREATE TABLE IF NOT EXISTS hospitality_rate_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_rate_unique ON hospitality_rate_overrides(unit_id, date);
CREATE INDEX IF NOT EXISTS idx_hosp_rate_client ON hospitality_rate_overrides(client_id);

-- Bookings — a date-range stay, not a single time-slot appointment. lead_id links back to the CRM
-- lead when the booking originated from a WhatsApp conversation; guest_name/guest_phone stand
-- alone for a booking entered directly (walk-in, phone call) with no CRM lead behind it.
CREATE TABLE IF NOT EXISTS hospitality_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  lead_id INTEGER,
  guest_name TEXT NOT NULL DEFAULT '',
  guest_phone TEXT NOT NULL DEFAULT '',
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  nights INTEGER NOT NULL DEFAULT 1,
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  rate_per_night REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  deposit_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL DEFAULT 'inquiry',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_bookings_client ON hospitality_bookings(client_id, check_in);
CREATE INDEX IF NOT EXISTS idx_hosp_bookings_unit ON hospitality_bookings(unit_id, check_in);
