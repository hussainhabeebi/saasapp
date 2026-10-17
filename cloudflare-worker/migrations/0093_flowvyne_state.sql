-- Flowvyne scripted-flow state — per-contact position in an active flow.
-- Keyed by (client_id, phone) so every contact's flow progress is independent.
-- flow_current_node: NULL means no active flow; non-NULL means mid-flow.
-- flow_variables: JSON object of captured variables from capture nodes.
CREATE TABLE IF NOT EXISTS flowvyne_conversation_state (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id          INTEGER NOT NULL,
  phone              TEXT    NOT NULL,
  flow_current_node  TEXT    DEFAULT NULL,
  flow_variables     TEXT    NOT NULL DEFAULT '{}',
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_flowvyne_state_contact
  ON flowvyne_conversation_state (client_id, phone);
