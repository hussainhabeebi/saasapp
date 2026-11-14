-- Atomic round-robin pointer for Lead Routing (Settings → 🔀 Lead Routing → Round-Robin).
-- The pointer used to live only in clients.lead_routing.rrIndex (NocoDB), read and then written
-- back — two leads arriving together both read the same index and went to the same rep. One
-- UPSERT … RETURNING here hands every lead its own slot. See engineNextRoundRobinSlot in worker.js.
CREATE TABLE IF NOT EXISTS lead_rr_counter (
  client_id INTEGER PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
