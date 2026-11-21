-- Settings → 📇 People & Contacts (business-contacts.js). Also created lazily by the Worker
-- (bcEnsureSchema), so applying this is optional.
-- One row per account: the official name, logo links, address, phone, email, and the contact person
-- for each department, as JSON. The bot adds these after its prompt and checks every reply against
-- them so it never sends an invented phone number or email.
CREATE TABLE IF NOT EXISTS business_contacts (
  client_id  INTEGER PRIMARY KEY,
  data_json  TEXT    NOT NULL,
  updated_by TEXT,
  updated_at TEXT    NOT NULL
);
