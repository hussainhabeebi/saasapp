-- Cold-lead auto-reallocation (Settings → 🔀 Lead Routing → "Auto-reallocate cold leads").
-- One row per owned lead: who owns it now, since when (the lead Owner field in NocoDB has no
-- "assigned at" timestamp of its own), who has already had it, and how many times the daily
-- sweep has moved it. See runColdLeadReallocationForAllClients in worker.js.
CREATE TABLE IF NOT EXISTS lead_owner_tracking (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  owner_since TEXT NOT NULL,
  previous_owners TEXT NOT NULL DEFAULT '[]',
  realloc_count INTEGER NOT NULL DEFAULT 0,
  warned_at TEXT,
  last_realloc_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, lead_id)
);
