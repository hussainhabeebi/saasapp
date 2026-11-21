-- Hospitality style H3: where each guest is in the Location → Property → Room flow, so a
-- question ("Price pls") is answered for what they are looking at instead of restarting the menu.
-- Also created on first use by hospH3EnsureState (worker.js).
CREATE TABLE IF NOT EXISTS hosp_h3_state (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  property TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (client_id, lead_id)
);
