-- Hospitality Pro Suite (cloudflare-worker/hospitality-suite.js, desktop UX frontend/hospitality.html).
-- Six full modules on top of Hospitality Pro, every feature its own toggle in hosp_suite_settings
-- (all OFF by default, so nothing changes for an existing client until they switch one on):
--   1. Guest Journey     — balance reminders + links, refunds, web check-in, ID scan, pre-arrival
--                          upsell, welcome/checkout messages, in-stay requests
--   2. Houseboat Ops     — fleet details, jetties + cruise plan, weather alerts, crew, meal
--                          pre-order, pickup updates, fuel + maintenance
--   3. Revenue & Channel — iCal sync with OTAs, pricing rules → suggestions, competitor rates,
--                          daily owner summary
--   4. Housekeeping      — room status board, auto clean/inspect tasks, staff task bot
--   5. Reviews & Memory  — guest profiles, post-stay feedback, AI review replies, rebooking and
--                          birthday/anniversary offers
--   6. Agent Desk        — travel agents, WhatsApp agent quotes, allotments, commissions
--
-- Purely additive: every table below is new. Existing hospitality_* tables are only written the
-- way staff already write them by hand — blocked dates (iCal imports / allotments, tagged in
-- hosp_suite_blocks so only those rows are ever removed again) and rate overrides (a pricing
-- suggestion the owner approved).

CREATE TABLE IF NOT EXISTS hosp_suite_settings (
  client_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL DEFAULT '{}',
  ical_token TEXT,
  updated_at TEXT NOT NULL
);

-- Last inbound WhatsApp message per lead — decides free text (inside the 24h window) vs template.
CREATE TABLE IF NOT EXISTS hosp_suite_contacts (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  phone_key TEXT NOT NULL DEFAULT '',
  conv_id TEXT,
  last_inbound_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_contacts_phone ON hosp_suite_contacts(client_id, phone_key);

-- Per-lead conversation state for suite WhatsApp flows (check-in, upsell, feedback, meals…).
CREATE TABLE IF NOT EXISTS hosp_suite_state (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id)
);

-- One row per booking the suite has touched: what was sent, check-in details, boat trip, agent.
CREATE TABLE IF NOT EXISTS hosp_suite_booking (
  booking_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  sent_json TEXT NOT NULL DEFAULT '{}',
  eta TEXT NOT NULL DEFAULT '',
  preferences TEXT NOT NULL DEFAULT '',
  checkin_status TEXT NOT NULL DEFAULT '',
  payment_url TEXT,
  payment_link_id TEXT,
  trip_type TEXT NOT NULL DEFAULT '',
  jetty_id INTEGER,
  boarding_time TEXT NOT NULL DEFAULT '',
  rating INTEGER,
  feedback TEXT NOT NULL DEFAULT '',
  agent_id INTEGER,
  commission_amount REAL NOT NULL DEFAULT 0,
  commission_status TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_booking_client ON hosp_suite_booking(client_id);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_booking_agent ON hosp_suite_booking(client_id, agent_id);

-- Money ledger per booking. kind: deposit | balance | extra | refund. status: paid | pending | refunded.
CREATE TABLE IF NOT EXISTS hosp_suite_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'balance',
  amount REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paid',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_payments_booking ON hosp_suite_payments(client_id, booking_id);

-- Extras bought after booking (pre-arrival upsell, in-stay, staff-added, upgrade requests).
CREATE TABLE IF NOT EXISTS hosp_suite_extras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  addon_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'prearrival',
  status TEXT NOT NULL DEFAULT 'requested',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_extras_booking ON hosp_suite_extras(client_id, booking_id);

-- ID documents read from guests' photos (web check-in). fields_json: {name,id_type,id_number,dob,nationality}.
CREATE TABLE IF NOT EXISTS hosp_suite_idscans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  image_url TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_idscans_booking ON hosp_suite_idscans(client_id, booking_id);

-- Houseboat details per unit. Trip rates: day cruise / overnight / night-stay (0 = not offered).
CREATE TABLE IF NOT EXISTS hosp_suite_fleet (
  unit_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  bedrooms INTEGER NOT NULL DEFAULT 1,
  deck_type TEXT NOT NULL DEFAULT '',
  ac TEXT NOT NULL DEFAULT 'ac',
  category TEXT NOT NULL DEFAULT '',
  day_cruise_rate REAL NOT NULL DEFAULT 0,
  overnight_rate REAL NOT NULL DEFAULT 0,
  night_stay_rate REAL NOT NULL DEFAULT 0,
  jetty_id INTEGER,
  engine_hours REAL NOT NULL DEFAULT 0,
  service_interval_hours REAL NOT NULL DEFAULT 250,
  last_service_hours REAL NOT NULL DEFAULT 0,
  last_service_date TEXT,
  service_alerted_at_hours REAL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_fleet_client ON hosp_suite_fleet(client_id);

-- Jetties / boarding points with their cruising window (local HH:MM).
CREATE TABLE IF NOT EXISTS hosp_suite_jetties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  map_url TEXT NOT NULL DEFAULT '',
  lat REAL,
  lng REAL,
  boarding_time TEXT NOT NULL DEFAULT '12:00',
  cruise_start TEXT NOT NULL DEFAULT '12:00',
  cruise_end TEXT NOT NULL DEFAULT '17:30',
  checkout_time TEXT NOT NULL DEFAULT '09:00',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_jetties_client ON hosp_suite_jetties(client_id);

-- Staff + crew. role: cook | driver | helper | housekeeping | maintenance | front_desk | manager.
CREATE TABLE IF NOT EXISTS hosp_suite_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'housekeeping',
  phone TEXT NOT NULL DEFAULT '',
  phone_key TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_staff_client ON hosp_suite_staff(client_id);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_staff_phone ON hosp_suite_staff(client_id, phone_key);

CREATE TABLE IF NOT EXISTS hosp_suite_crew_assign (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  staff_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_suite_crew_unique ON hosp_suite_crew_assign(booking_id, staff_id);

-- Menu for meal pre-ordering. meal: breakfast | lunch | snacks | dinner.
CREATE TABLE IF NOT EXISTS hosp_suite_menu (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  meal TEXT NOT NULL DEFAULT 'lunch',
  name TEXT NOT NULL,
  veg INTEGER NOT NULL DEFAULT 1,
  price REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_menu_client ON hosp_suite_menu(client_id);

CREATE TABLE IF NOT EXISTS hosp_suite_meal_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  meal TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_suite_meal_unique ON hosp_suite_meal_orders(booking_id, meal);

-- Fuel and service log per boat. kind: fuel | service | repair.
CREATE TABLE IF NOT EXISTS hosp_suite_boatlog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fuel',
  date TEXT NOT NULL,
  litres REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  engine_hours REAL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_boatlog_unit ON hosp_suite_boatlog(client_id, unit_id);

-- iCal feeds to import (Airbnb / Booking.com / Agoda / MakeMyTrip calendars) per unit.
CREATE TABLE IF NOT EXISTS hosp_suite_ical (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  last_sync_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  events INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_ical_client ON hosp_suite_ical(client_id);

-- hospitality_blocked_dates rows this module created (origin 'ical:<feed id>' or 'allot:<id>'),
-- so a sync / release only ever removes its own blocks, never one staff added by hand.
CREATE TABLE IF NOT EXISTS hosp_suite_blocks (
  client_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  unit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (unit_id, date)
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_blocks_origin ON hosp_suite_blocks(client_id, origin);

-- Pricing rules. kind: weekend | season | event | high_demand | last_minute. pct may be negative.
CREATE TABLE IF NOT EXISTS hosp_suite_price_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  unit_id INTEGER,
  start_date TEXT,
  end_date TEXT,
  pct REAL NOT NULL DEFAULT 0,
  threshold REAL NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_rules_client ON hosp_suite_price_rules(client_id);

-- status: pending | applied | dismissed.
CREATE TABLE IF NOT EXISTS hosp_suite_price_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  current_rate REAL NOT NULL,
  suggested_rate REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_suite_sugg_unique ON hosp_suite_price_suggestions(client_id, unit_id, date);

CREATE TABLE IF NOT EXISTS hosp_suite_competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hosp_suite_comp_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  competitor_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  room_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_comp_rates ON hosp_suite_comp_rates(client_id, date);

-- Staff alert inbox (weather, low rating, competitor drop, service due, unsent message…).
CREATE TABLE IF NOT EXISTS hosp_suite_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_alerts_client ON hosp_suite_alerts(client_id, status);

CREATE TABLE IF NOT EXISTS hosp_suite_summaries (
  client_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, date)
);

-- Room / boat status board. status: clean | dirty | inspected | out_of_order.
CREATE TABLE IF NOT EXISTS hosp_suite_room_status (
  unit_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'clean',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- Tasks. kind: housekeeping | maintenance | request | other. status: open | in_progress | done.
-- auto_key de-duplicates generated tasks (e.g. 'clean:<booking id>').
CREATE TABLE IF NOT EXISTS hosp_suite_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  unit_id INTEGER,
  booking_id INTEGER,
  assignee_id INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  due_date TEXT,
  source TEXT NOT NULL DEFAULT 'staff',
  notes TEXT NOT NULL DEFAULT '',
  auto_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_tasks_client ON hosp_suite_tasks(client_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosp_suite_tasks_auto ON hosp_suite_tasks(client_id, auto_key);

-- Guest memory, keyed by the last 10 digits of the phone. birthday / anniversary: 'MM-DD'.
CREATE TABLE IF NOT EXISTS hosp_suite_guests (
  client_id INTEGER NOT NULL,
  phone_key TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  birthday TEXT NOT NULL DEFAULT '',
  anniversary TEXT NOT NULL DEFAULT '',
  preferences TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  occasion_sent_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, phone_key)
);

-- Online reviews pasted in for an AI-drafted reply. status: new | drafted | replied.
CREATE TABLE IF NOT EXISTS hosp_suite_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'Google',
  author TEXT NOT NULL DEFAULT '',
  rating INTEGER,
  text TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_reviews_client ON hosp_suite_reviews(client_id);

CREATE TABLE IF NOT EXISTS hosp_suite_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  phone_key TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  commission_pct REAL NOT NULL DEFAULT 10,
  credit_limit REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_agents_phone ON hosp_suite_agents(client_id, phone_key);

-- Rooms / boats set aside for an agent, released release_days before the date. status: active | released.
CREATE TABLE IF NOT EXISTS hosp_suite_allotments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  release_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosp_suite_allot_client ON hosp_suite_allotments(client_id, status);

-- Once-a-day job markers (pricing suggestions, daily summary, housekeeping list…).
CREATE TABLE IF NOT EXISTS hosp_suite_runs (
  client_id INTEGER NOT NULL,
  job TEXT NOT NULL,
  date TEXT NOT NULL,
  PRIMARY KEY (client_id, job, date)
);
