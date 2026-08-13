-- Follow-up Engine: brings back an optional second variant per step (removed in the
-- migrations/0047 rebuild) — but auto-weighted toward whichever one actually gets replies, instead
-- of a fixed 50/50 split forever. A step with no Variant B configured just always sends A, same
-- behavior as before this migration. See worker.js pickLadderVariant for the weighting logic and
-- sendFollowupLadderStep for how a variant's content is resolved before sending.
ALTER TABLE followup_ladder_steps ADD COLUMN message_b TEXT NOT NULL DEFAULT '';
ALTER TABLE followup_ladder_steps ADD COLUMN template_name_b TEXT NOT NULL DEFAULT '';
ALTER TABLE followup_ladder_steps ADD COLUMN template_language_b TEXT NOT NULL DEFAULT 'en_US';
ALTER TABLE followup_ladder_steps ADD COLUMN template_category_b TEXT NOT NULL DEFAULT 'MARKETING';
ALTER TABLE followup_ladder_steps ADD COLUMN template_body_vars_b INTEGER NOT NULL DEFAULT 0;
