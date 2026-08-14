-- Healthcare module (frontend/healthcare.html — "🏥 Healthcare" dashboard nav tab, gated by
-- CLIENTS.healthcare_enabled same as real_estate_enabled/hospitality_enabled/b2b_enabled). Same
-- iframe-embed + session-token pattern as Real Estate (migrations/0031_real_estate.sql) — genuinely
-- new data with no existing NocoDB reader, so it's fully D1 (env.DB), not NocoDB.
--
-- Structured like Ecom's Categories -> Products (migrations/0012_ecom_categories.sql,
-- 0043_ecom_products_mirror.sql), renamed to the healthcare domain: Departments -> Doctors.
-- Departments carry up to 3 photos (same image_url_1/2/3 shape as ecom_categories). Doctors carry
-- the same "5 images + video + PDF" media shape as re_units/re_projects (migrations/0049, 0053) —
-- PDF is typically a CV/certificate, video a short intro clip — using the same zero-storage-cost
-- pasted-Google-Drive-share-link convention as every other module's media fields.

CREATE TABLE IF NOT EXISTS healthcare_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url_1 TEXT NOT NULL DEFAULT '',
  image_url_2 TEXT NOT NULL DEFAULT '',
  image_url_3 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healthcare_departments_client ON healthcare_departments(client_id);

-- Doctors — the parent Department is required (a doctor belongs to exactly one department, unlike
-- ecom's loose free-text category match on products; there's no legacy free-text data to reconcile
-- here so a real FK is the natural choice from day one).
CREATE TABLE IF NOT EXISTS healthcare_doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  qualification TEXT NOT NULL DEFAULT '',
  specialization TEXT NOT NULL DEFAULT '',
  experience_years INTEGER NOT NULL DEFAULT 0,
  consultation_fee REAL NOT NULL DEFAULT 0,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_url_2 TEXT NOT NULL DEFAULT '',
  image_url_3 TEXT NOT NULL DEFAULT '',
  image_url_4 TEXT NOT NULL DEFAULT '',
  image_url_5 TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  pdf_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healthcare_doctors_client ON healthcare_doctors(client_id);
CREATE INDEX IF NOT EXISTS idx_healthcare_doctors_department ON healthcare_doctors(department_id);
