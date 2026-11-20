-- 👤 Profiles (passenger-profiles.js) — travel agency and hospitality accounts. Also created lazily
-- by the Worker (ppEnsureSchema), so applying this is optional.
-- One profile per traveller / guest, kept across bookings; their documents (passport, visa,
-- residence permit…) with expiry dates; the reminders raised from them (one row per reminder step,
-- so nothing is raised twice); and an audit log of edits and of every full document number viewed.
CREATE TABLE IF NOT EXISTS pp_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone_key TEXT NOT NULL DEFAULT '',
  lead_id INTEGER,
  date_of_birth TEXT NOT NULL DEFAULT '',
  anniversary TEXT NOT NULL DEFAULT '',
  family_group TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pp_profiles_client ON pp_profiles(client_id, phone_key);

CREATE TABLE IF NOT EXISTS pp_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  profile_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pp_documents_profile ON pp_documents(client_id, profile_id);

CREATE TABLE IF NOT EXISTS pp_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  rkey TEXT NOT NULL,
  kind TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  doc_id INTEGER,
  due_date TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  UNIQUE(client_id, rkey)
);
CREATE INDEX IF NOT EXISTS idx_pp_reminders_open ON pp_reminders(client_id, status);

CREATE TABLE IF NOT EXISTS pp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  profile_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pp_audit_profile ON pp_audit(client_id, profile_id);
