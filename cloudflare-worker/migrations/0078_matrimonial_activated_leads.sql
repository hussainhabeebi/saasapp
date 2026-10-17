-- Tracks which WhatsApp leads are allowed to view profiles via the chat menu,
-- with per-customer limits (daily, monthly) and profile-type access control.
CREATE TABLE IF NOT EXISTS matrimonial_activated_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  can_view TEXT DEFAULT 'both' CHECK(can_view IN ('both','bride','groom')),
  daily_limit INTEGER DEFAULT 10,
  monthly_limit INTEGER DEFAULT 50,
  expiry_date TEXT,
  views_today INTEGER DEFAULT 0,
  views_month INTEGER DEFAULT 0,
  last_daily_reset TEXT,
  last_monthly_reset TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','suspended','expired')),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_matri_activated ON matrimonial_activated_leads(client_id, phone);
