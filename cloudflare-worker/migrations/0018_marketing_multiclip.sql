-- Marketing Studio module — multi-clip projects (SETUP.md "Marketing Studio module — Multi-clip
-- projects & template library"). A project can now hold several uploaded video clips, stitched
-- together (via render-pipeline's POST /concat-clips) into one combined source video before the
-- existing transcribe/caption/render pipeline runs on it unchanged — concatenation happens once,
-- up front, so nothing downstream needs to know a project ever had more than one clip.
CREATE TABLE IF NOT EXISTS marketing_project_clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  source_duration_sec REAL,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_project_clips_project ON marketing_project_clips(project_id, order_index);
