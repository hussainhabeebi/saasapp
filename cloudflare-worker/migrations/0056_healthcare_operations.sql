-- Healthcare operations: verified services, doctor schedules, appointments, insurance and
-- emergency/handover settings.  These tables intentionally stay client-scoped in D1, matching
-- the existing healthcare_departments/healthcare_doctors module.

CREATE TABLE IF NOT EXISTS healthcare_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  short_label TEXT NOT NULL DEFAULT '',
  aliases TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  preparation TEXT NOT NULL DEFAULT '',
  booking_url TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  image_url_2 TEXT NOT NULL DEFAULT '',
  image_url_3 TEXT NOT NULL DEFAULT '',
  image_url_4 TEXT NOT NULL DEFAULT '',
  image_url_5 TEXT NOT NULL DEFAULT '',
  audio_url TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  pdf_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_healthcare_services_client ON healthcare_services(client_id);
CREATE INDEX IF NOT EXISTS idx_healthcare_services_department ON healthcare_services(department_id);

CREATE TABLE IF NOT EXISTS healthcare_doctor_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  doctor_id INTEGER NOT NULL,
  weekday INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  break_start TEXT NOT NULL DEFAULT '',
  break_end TEXT NOT NULL DEFAULT '',
  slot_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healthcare_schedules_doctor ON healthcare_doctor_schedules(client_id, doctor_id, weekday);

CREATE TABLE IF NOT EXISTS healthcare_appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  patient_name TEXT NOT NULL,
  patient_phone TEXT NOT NULL,
  lead_id INTEGER NOT NULL DEFAULT 0,
  service_id INTEGER NOT NULL DEFAULT 0,
  doctor_id INTEGER NOT NULL DEFAULT 0,
  appointment_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  source TEXT NOT NULL DEFAULT 'dashboard',
  notes TEXT NOT NULL DEFAULT '',
  gcal_event_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_healthcare_appointments_client_date ON healthcare_appointments(client_id, appointment_date);
CREATE INDEX IF NOT EXISTS idx_healthcare_appointments_doctor_slot ON healthcare_appointments(client_id, doctor_id, appointment_date, start_time);
CREATE UNIQUE INDEX IF NOT EXISTS idx_healthcare_appointments_active_slot
  ON healthcare_appointments(client_id, doctor_id, appointment_date, start_time)
  WHERE status NOT IN ('cancelled','completed','no_show');

CREATE TABLE IF NOT EXISTS healthcare_insurance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  provider_name TEXT NOT NULL,
  network_name TEXT NOT NULL DEFAULT '',
  plan_name TEXT NOT NULL DEFAULT '',
  covered_services TEXT NOT NULL DEFAULT '',
  preapproval_required INTEGER NOT NULL DEFAULT 0,
  verification_note TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_verified_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_healthcare_insurance_client ON healthcare_insurance(client_id);

CREATE TABLE IF NOT EXISTS healthcare_settings (
  client_id INTEGER PRIMARY KEY,
  strict_zero_hallucination INTEGER NOT NULL DEFAULT 1,
  emergency_keywords TEXT NOT NULL DEFAULT 'chest pain,cannot breathe,can''t breathe,unconscious,severe bleeding,stroke,suicidal,overdose',
  emergency_message TEXT NOT NULL DEFAULT 'This may require urgent medical attention. Please contact local emergency services or the clinic immediately.',
  handover_message TEXT NOT NULL DEFAULT 'I am connecting you to the clinic team now. Please stay available for their response.',
  emergency_contact TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS healthcare_media_sent (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  sent_date TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id, service_id, sent_date)
);
