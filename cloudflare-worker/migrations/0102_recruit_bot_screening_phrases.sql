-- Per-job phrases the WhatsApp bot uses when it tells an applicant they are (or are not) eligible:
-- recruit_jobs.eligible_phrases / recruit_jobs.ineligible_phrases (TEXT, one phrase per line).
-- NOTE: no ALTER TABLE here. The worker adds both columns itself on first use
-- (ensureRecruitJobsSchema in worker.js), so on production they already existed by the time this
-- migration ran and `ALTER TABLE … ADD COLUMN` failed with "duplicate column name:
-- eligible_phrases" — SQLite has no ADD COLUMN IF NOT EXISTS. Same SELECT no-op pattern as
-- 0070_live_travel_client_credentials.sql; fresh databases get the columns from the worker.
SELECT 1;
