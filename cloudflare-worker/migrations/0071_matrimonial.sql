-- Matrimonial Service module tables

CREATE TABLE IF NOT EXISTS matrimonial_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  profile_type TEXT NOT NULL CHECK(profile_type IN ('bride','groom')),
  full_name TEXT NOT NULL,
  date_of_birth TEXT,
  religion TEXT,
  caste TEXT,
  sub_caste TEXT,
  mother_tongue TEXT,
  height_cm INTEGER,
  complexion TEXT,
  education TEXT,
  occupation TEXT,
  annual_income TEXT,
  city TEXT,
  state TEXT,
  country TEXT DEFAULT 'India',
  about TEXT,
  family_type TEXT CHECK(family_type IN ('nuclear','joint','')),
  father_name TEXT,
  father_occupation TEXT,
  mother_name TEXT,
  mother_occupation TEXT,
  siblings TEXT,
  horoscope_star TEXT,
  horoscope_rashi TEXT,
  horoscope_notes TEXT,
  manglik TEXT CHECK(manglik IN ('yes','no','partial','')),
  photo_url TEXT,
  photo_url_2 TEXT,
  photo_url_3 TEXT,
  biodata_pdf_url TEXT,
  membership_plan TEXT DEFAULT 'free' CHECK(membership_plan IN ('free','silver','gold','platinum')),
  membership_expiry TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','matched','hidden')),
  lead_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matrimonial_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  profile_id_1 INTEGER NOT NULL,
  profile_id_2 INTEGER NOT NULL,
  match_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'suggested' CHECK(status IN ('suggested','interest_sent','mutual','family_meeting_arranged','family_meeting_done','engaged','married','rejected','on_hold')),
  interest_sent_by INTEGER,
  notes TEXT,
  family_meeting_date TEXT,
  family_meeting_venue TEXT,
  outcome_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matrimonial_shortlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  shortlisted_profile_id INTEGER NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matrimonial_success_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  profile_id_1 INTEGER,
  profile_id_2 INTEGER,
  bride_name TEXT NOT NULL,
  groom_name TEXT NOT NULL,
  wedding_date TEXT,
  testimonial TEXT,
  photo_url TEXT,
  featured INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matrimonial_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT UNIQUE NOT NULL,
  service_name TEXT DEFAULT 'Matrimonial Service',
  membership_plans TEXT DEFAULT '{}',
  horoscope_matching_enabled INTEGER DEFAULT 0,
  auto_suggest_matches INTEGER DEFAULT 1,
  match_criteria_weights TEXT DEFAULT '{}',
  privacy_note TEXT,
  success_story_template TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_matri_profiles_client ON matrimonial_profiles(client_id);
CREATE INDEX IF NOT EXISTS idx_matri_profiles_type   ON matrimonial_profiles(client_id, profile_type);
CREATE INDEX IF NOT EXISTS idx_matri_matches_client  ON matrimonial_matches(client_id);
CREATE INDEX IF NOT EXISTS idx_matri_shortlists      ON matrimonial_shortlists(client_id, profile_id);
