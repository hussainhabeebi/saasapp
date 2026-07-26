-- Marketing Studio module — Remotion-engine templates (SETUP.md "Marketing Studio module —
-- Remotion animated templates"). A template can now be backed by a real animated React/Remotion
-- composition (render-pipeline/remotion/) instead of the default static ffmpeg text/image
-- "scenes" — same marketing_templates table, just an alternate render path selected by `engine`.
ALTER TABLE marketing_templates ADD COLUMN engine TEXT NOT NULL DEFAULT 'ffmpeg';
ALTER TABLE marketing_templates ADD COLUMN remotion_composition_id TEXT;
ALTER TABLE marketing_templates ADD COLUMN props_schema_json TEXT;
