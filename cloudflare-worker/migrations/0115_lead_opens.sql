-- Baby Care unattended-lead reassignment (Settings → 🔀 Lead Routing → "Reassign unopened leads").
-- When a staff member opens a lead (Leads detail pane or the Chats thread), POST /leads/opened
-- records it here; the 15-minute sweep moves a lead whose owner hasn't opened it within the set
-- hours of getting it, or whose owner is marked On leave. See unattendedReallocProcessClient in
-- worker.js, which also creates this table lazily, so a deploy that hasn't run this still works.
CREATE TABLE IF NOT EXISTS lead_opens (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  first_opened_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id, email)
);
