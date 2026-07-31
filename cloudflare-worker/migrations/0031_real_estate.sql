-- Real Estate module (frontend/real-estate.html — "🏘️ Real Estate" dashboard nav tab, gated by
-- CLIENTS.real_estate_enabled same as b2b_enabled/hospitality_enabled). Same iframe-embed pattern
-- as B2B/Accounting (its own self-contained page, passed client id + session token). Fully D1
-- (env.DB), same reasoning as the Hospitality module: tower/floor/unit inventory with hold-expiry
-- states, payment-milestone schedules and channel-partner commissions are a genuinely new data
-- shape with no existing NocoDB view reading any of it. Leads (source portal, budget, urgency,
-- score, zone, project, language, investor flag) stay plain LEADS columns on the existing NocoDB
-- table instead — see ensureRealEstateLeadFields in worker.js — because every existing lead view
-- (kanban, lead list, Team Performance, exports) already reads leads out of NocoDB and gains this
-- module's fields for free.

-- Projects (a tower/development, e.g. "Marina Heights") — the parent of Units below, and the level
-- RERA registration/brochure/floor-plan documents and price-list versioning attach to.
CREATE TABLE IF NOT EXISTS re_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  rera_number TEXT NOT NULL DEFAULT '',
  total_towers INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  virtual_tour_url TEXT NOT NULL DEFAULT '',
  price_list_version TEXT NOT NULL DEFAULT 'v1',
  base_price_per_sqft REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_projects_client ON re_projects(client_id);

-- Unit-level inventory: tower -> floor -> unit, with real-time availability status and an
-- optional hold_expires_at timer (a "hold" reverts to "available" client-side once past, and
-- handleReUnitsList sweeps expired holds back to available on every read — see worker.js).
CREATE TABLE IF NOT EXISTS re_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  tower TEXT NOT NULL DEFAULT '',
  floor INTEGER NOT NULL DEFAULT 0,
  unit_no TEXT NOT NULL,
  unit_type TEXT NOT NULL DEFAULT '',
  area_sqft REAL NOT NULL DEFAULT 0,
  base_price REAL NOT NULL DEFAULT 0,
  plc_charges REAL NOT NULL DEFAULT 0,
  floor_rise_charges REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  hold_expires_at TEXT,
  virtual_tour_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_units_client ON re_units(client_id);
CREATE INDEX IF NOT EXISTS idx_re_units_project ON re_units(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_re_units_unique ON re_units(project_id, tower, unit_no);

-- Site visits — scheduled viewing of a unit/project by a lead, with transport/driver coordination
-- notes and a reminder flag (the reminder itself rides the existing Follow-up Engine, see
-- handleReSiteVisitCreate's comment). feedback is filled in after the visit for the funnel/
-- conversion analytics tab.
CREATE TABLE IF NOT EXISTS re_site_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER,
  unit_id INTEGER,
  project_id INTEGER,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  transport_notes TEXT NOT NULL DEFAULT '',
  feedback TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_visits_client ON re_site_visits(client_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_re_visits_lead ON re_site_visits(lead_id);

-- Bookings — a unit moving from hold to sold: token amount, payment plan type, agreement/
-- possession tracking. One unit has at most one non-cancelled booking (enforced app-side, not by a
-- unique index, since a cancelled booking must stay in history while the unit re-opens for sale).
CREATE TABLE IF NOT EXISTS re_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  lead_id INTEGER,
  cp_id INTEGER,
  buyer_name TEXT NOT NULL DEFAULT '',
  buyer_phone TEXT NOT NULL DEFAULT '',
  is_investor INTEGER NOT NULL DEFAULT 0,
  token_amount REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  payment_plan TEXT NOT NULL DEFAULT 'construction_linked',
  status TEXT NOT NULL DEFAULT 'booked',
  agreement_url TEXT NOT NULL DEFAULT '',
  loan_status TEXT NOT NULL DEFAULT '',
  booking_date TEXT NOT NULL,
  possession_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_bookings_client ON re_bookings(client_id);
CREATE INDEX IF NOT EXISTS idx_re_bookings_unit ON re_bookings(unit_id);
CREATE INDEX IF NOT EXISTS idx_re_bookings_lead ON re_bookings(lead_id);

-- Payment schedule / demand notes per booking — a construction-linked plan's milestones
-- (foundation/slab/handover %) or any custom schedule the sales team enters.
CREATE TABLE IF NOT EXISTS re_payment_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  due_date TEXT,
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_date TEXT,
  demand_note_sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_milestones_booking ON re_payment_milestones(booking_id);
CREATE INDEX IF NOT EXISTS idx_re_milestones_client ON re_payment_milestones(client_id);

-- Post-possession complaint/ticket tracking, and resale/renewal tracking for investor clients
-- (is_resale_listed on the booking's unit is tracked via re_units.status='resale_listed' instead
-- of a separate column here — see worker.js handleReBookingUpdate).
CREATE TABLE IF NOT EXISTS re_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  booking_id INTEGER,
  subject TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_re_tickets_client ON re_tickets(client_id);
CREATE INDEX IF NOT EXISTS idx_re_tickets_booking ON re_tickets(booking_id);

-- Channel partners (brokers/agents) — onboarding/KYC and their commission slab, referenced by
-- re_bookings.cp_id and Leads.re_cp_id (a CP-submitted lead) for the CP portal view inside
-- real-estate.html.
CREATE TABLE IF NOT EXISTS re_channel_partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  kyc_status TEXT NOT NULL DEFAULT 'pending',
  commission_slab_pct REAL NOT NULL DEFAULT 0,
  portal_token TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_cp_client ON re_channel_partners(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_re_cp_portal_token ON re_channel_partners(portal_token);

-- Commission calculation/payout tracking per booking a CP is credited with — tiered/milestone
-- payouts are just multiple rows against the same booking_id+cp_id.
CREATE TABLE IF NOT EXISTS re_cp_commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  cp_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  milestone TEXT NOT NULL DEFAULT 'booking',
  amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  payout_date TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_comm_client ON re_cp_commissions(client_id);
CREATE INDEX IF NOT EXISTS idx_re_comm_cp ON re_cp_commissions(cp_id);

-- Document repository per project/unit (RERA disclosures, brochures, floor plans) — url-based
-- (this Worker has no object storage of its own outside the Hospitality media endpoint, and
-- linking an externally-hosted PDF/image is a genuine fit for "documents a sales team already has
-- on Drive/S3", not a workaround).
CREATE TABLE IF NOT EXISTS re_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER,
  unit_id INTEGER,
  doc_type TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  is_rera INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_docs_client ON re_documents(client_id);
CREATE INDEX IF NOT EXISTS idx_re_docs_project ON re_documents(project_id);

-- Audit trail for price changes and discount approvals (RERA compliance) — one row per changed
-- field, written by handleReUnitUpdate whenever base_price/plc_charges/floor_rise_charges change.
CREATE TABLE IF NOT EXISTS re_price_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_re_audit_unit ON re_price_audit(unit_id);
CREATE INDEX IF NOT EXISTS idx_re_audit_client ON re_price_audit(client_id);
