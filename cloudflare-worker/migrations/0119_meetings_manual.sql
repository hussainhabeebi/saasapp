-- Meetings V2 (worker.js "Cal.com Meetings" → mtgEnsureSchema): meetings a rep marks by hand from a
-- lead's ⋯ menu (booked on a call / in WhatsApp, not through Cal.com), the "agreed — time not fixed"
-- state, per-meeting WhatsApp opt-out, and the rep's pre-meeting brief. mtgEnsureSchema adds the
-- same columns lazily, so a deploy that hasn't run this migration still works.
ALTER TABLE meetings ADD COLUMN source TEXT;          -- calcom | manual
ALTER TABLE meetings ADD COLUMN mode TEXT;            -- video | phone | in_person
ALTER TABLE meetings ADD COLUMN location TEXT;        -- address for in-person meetings
ALTER TABLE meetings ADD COLUMN scheduled_by TEXT;    -- rep who marked it (points credit); Cal.com bookings credit sent_by
ALTER TABLE meetings ADD COLUMN notify INTEGER;       -- 0 = no WhatsApp confirm/reminders to the lead; NULL/1 = send
ALTER TABLE meetings ADD COLUMN note TEXT;
ALTER TABLE meetings ADD COLUMN brief_at TEXT;        -- pre-meeting brief sent to the rep
CREATE INDEX IF NOT EXISTS idx_meetings_lead ON meetings(client_id, lead_id, status);
