-- Marketing Studio module — Video Templates (SETUP.md "Marketing Studio module — Video
-- Templates"), inspired by "create videos using code instead of editing, generate hundreds
-- automatically" (HeyGen HyperFrames-style bulk/programmatic generation): define a template
-- once as a scene spec with {{variable}} placeholders, then batch-generate one rendered video
-- per data row (e.g. one ad per product, one social clip per lead) instead of editing each by
-- hand. Same D1-not-NocoDB reasoning as the rest of this module.
CREATE TABLE IF NOT EXISTS marketing_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  scenes_json TEXT NOT NULL,          -- [{type:'text'|'image', content:'Hi {{name}}', ...style}, ...] — content may contain {{var}} placeholders
  target_aspect TEXT NOT NULL DEFAULT '9:16',
  style_id TEXT,
  estimated_duration_sec REAL NOT NULL DEFAULT 15,  -- author-set estimate, used for the pre-generate usage/minutes check (actual duration isn't known until the external pipeline renders it)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_templates_client ON marketing_templates(client_id);

-- A project generated from a template (as opposed to an uploaded/trimmed source video) carries
-- which template + which row of variables it came from, so the batch's results can be traced
-- back and a single row can be regenerated without re-running the whole batch.
ALTER TABLE marketing_projects ADD COLUMN template_id INTEGER;
ALTER TABLE marketing_projects ADD COLUMN template_vars_json TEXT;
