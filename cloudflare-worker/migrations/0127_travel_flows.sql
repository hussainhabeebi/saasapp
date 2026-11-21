-- Travel Settings → 🧩 Flows: AI-first booking flows (travel-flows.js). Also created lazily by the
-- Worker (tfEnsureSchema), so applying this is optional.
-- lt_travel_flows: one row per flow. status draft | active | paused; only active flows run.
CREATE TABLE IF NOT EXISTS lt_travel_flows (
  client_id  INTEGER NOT NULL,
  id         TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'draft',
  flow_json  TEXT    NOT NULL DEFAULT '{}',
  position   INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (client_id, id)
);
-- A chat's progress in a flow, with a copy of the flow it started on. Expires after 24 h.
CREATE TABLE IF NOT EXISTS lt_travel_flow_state (
  client_id  INTEGER NOT NULL,
  phone      TEXT    NOT NULL,
  state_json TEXT    NOT NULL DEFAULT '{}',
  expires_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (client_id, phone)
);
-- Counters per flow: started, finished, completed, handed_over, paused, resumed, cancelled,
-- side_answers, step:<id> (reached).
CREATE TABLE IF NOT EXISTS lt_travel_flow_stats (
  client_id INTEGER NOT NULL,
  flow_id   TEXT    NOT NULL,
  metric    TEXT    NOT NULL,
  n         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, flow_id, metric)
);
