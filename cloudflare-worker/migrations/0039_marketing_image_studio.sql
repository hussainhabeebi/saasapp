-- Marketing Studio module — Image Studio (SETUP.md "Marketing Studio module — Image Studio"):
-- fal.ai text-to-image/image-edit generation plus deterministic (ffmpeg, no AI) logo watermarking,
-- background compositing and text-overlay graphics. This table exists purely so "images generated
-- this month" can be shown as a usage counter (same reasoning/shape as marketing_minutes_used) —
-- every successful image operation (whichever kind) logs one row here, whether or not it ends up
-- attached to a marketing_content_posts row.
CREATE TABLE IF NOT EXISTS marketing_image_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,   -- generate | restyle | remove-background | watermark | composite-background | text-overlay
  image_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_image_log_client_date ON marketing_image_log(client_id, created_at);
