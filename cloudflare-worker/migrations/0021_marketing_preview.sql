-- Marketing Studio module — Apply/preview for auto-edit & cues (SETUP.md "Marketing Studio
-- module — Apply/preview renders"). A preview is a real render job (same marketing_jobs row
-- shape, same render pipeline), just short (a few seconds) and draft-quality, and — unlike a
-- normal render — must NOT overwrite the project's real output_key/output_url/status or count
-- against marketing_minutes_used. Giving jobs their own output_url lets a preview's result be
-- read directly off its job row instead of the project row, so the two can never collide.
ALTER TABLE marketing_jobs ADD COLUMN output_url TEXT;
