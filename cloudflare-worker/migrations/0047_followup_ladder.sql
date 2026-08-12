-- Follow-up Engine ladder (frontend/broadcast.html "💪 Follow-up Engine" tab) — replaces the old
-- per-step A/B-variant model (followup_variants, migrations/0007) with one fixed 5-step sequence,
-- consolidating every follow-up setting into this one tab (previously split between here and
-- dashboard.html's Settings → Follow-up Messages):
--   Step 1-2: plain WhatsApp session messages, sent while still inside the 24h customer-service
--             window (hours is merchant-configurable, must stay under 24).
--   Step 3-5: approved WhatsApp template messages via Meta's Graph API directly, fixed at 2/4/7
--             days of silence — templates are required past 24h because WhatsApp's Cloud API
--             rejects free-form (non-template) messages outside that window; sending the old classic
--             sequence's later steps as plain session messages was very likely silently failing for
--             any client whose followup_hours crossed 24.
-- One row per (client_id, step). followup_variants/followup_sends (migrations/0007) are left in
-- place, not dropped — followup_sends keeps logging against this new ladder too (its schema already
-- just keys off step number, nothing A/B-specific); only followup_variants itself goes unused.
CREATE TABLE IF NOT EXISTS followup_ladder_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  step INTEGER NOT NULL,                          -- 1-5, fixed meaning (see comment above)
  type TEXT NOT NULL,                              -- 'session' (steps 1-2) | 'template' (steps 3-5)
  hours INTEGER,                                   -- steps 1-2 only: hours of silence before this fires
  days INTEGER,                                    -- steps 3-5 only: fixed at 2/4/7, stored for clarity
  message TEXT NOT NULL DEFAULT '',                -- steps 1-2 only
  template_name TEXT NOT NULL DEFAULT '',          -- steps 3-5 only
  template_language TEXT NOT NULL DEFAULT 'en_US',
  template_category TEXT NOT NULL DEFAULT 'MARKETING',
  template_body_vars INTEGER NOT NULL DEFAULT 0,   -- count of {{n}} placeholders in the template's
                                                    -- BODY component, so the send step knows how many
                                                    -- parameters to fill (each filled with the lead's
                                                    -- name — see sendFollowupLadderStep)
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_ladder_steps_unique ON followup_ladder_steps(client_id, step);
