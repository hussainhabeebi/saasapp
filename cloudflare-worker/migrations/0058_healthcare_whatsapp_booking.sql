-- Native WhatsApp Healthcare appointment state. The customer stays inside WhatsApp while
-- selecting a verified doctor, date and live slot; unfinished sessions expire automatically.
CREATE TABLE IF NOT EXISTS healthcare_booking_sessions (
  client_id INTEGER NOT NULL,
  patient_phone TEXT NOT NULL,
  conversation_id INTEGER NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT '',
  service_id INTEGER NOT NULL DEFAULT 0,
  doctor_id INTEGER NOT NULL DEFAULT 0,
  appointment_date TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  patient_name TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, patient_phone)
);

CREATE INDEX IF NOT EXISTS idx_healthcare_booking_sessions_expiry
  ON healthcare_booking_sessions(expires_at);
