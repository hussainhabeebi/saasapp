-- Meetings V2 (worker.js "Cal.com Meetings" → mtgEnsureSchema): meetings a rep marks by hand from a
-- lead's ⋯ menu (booked on a call / in WhatsApp, not through Cal.com), the "agreed — time not fixed"
-- state, per-meeting WhatsApp opt-out, and the rep's pre-meeting brief. mtgEnsureSchema adds the
-- same columns lazily, so a deploy that hasn't run this migration still works.
-- The columns themselves are NOT added here: mtgEnsureSchema (MTG_V2_COLUMNS) already adds them on
-- first use, so on a live database they usually exist and an ALTER would fail the whole migration
-- with "duplicate column name" (SQLite has no ADD COLUMN IF NOT EXISTS). For reference they are:
--   source TEXT (calcom | manual), mode TEXT (video | phone | in_person), location TEXT,
--   scheduled_by TEXT, notify INTEGER (0 = no WhatsApp to the lead), note TEXT, brief_at TEXT
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(client_id, lead_id, status);
