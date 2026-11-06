-- One row per (client, phone) that the engine has started creating a lead for. The UNIQUE key
-- makes exactly one concurrent webhook the lead creator; the others reuse its lead_id instead of
-- POSTing a duplicate Leads row. See engineCreateLeadOnce in worker.js.
CREATE TABLE IF NOT EXISTS lead_create_claims (
  client_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  lead_id INTEGER,
  at INTEGER NOT NULL,
  PRIMARY KEY (client_id, phone)
);
