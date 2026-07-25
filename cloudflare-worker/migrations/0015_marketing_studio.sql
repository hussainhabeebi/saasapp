-- Marketing Studio module (SETUP.md "Marketing Studio module") — short-form video repurposing:
-- upload a long video, auto-transcribe it, edit captions, pick a caption style, render a
-- vertical (or square/landscape) clip. Cloudflare D1 (env.DB), not NocoDB: a genuinely new data
-- shape with no existing NocoDB reader, same reasoning as ecom_categories/review_config.
CREATE TABLE IF NOT EXISTS marketing_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  source_key TEXT,                        -- R2 object key (MARKETING_MEDIA bucket), set once the upload completes
  source_duration_sec REAL,               -- reported by the browser (<video>.duration) at upload time — the Worker never decodes video
  target_aspect TEXT NOT NULL DEFAULT '9:16',
  trim_start_sec REAL NOT NULL DEFAULT 0,
  trim_end_sec REAL,
  language TEXT,                          -- BCP-47ish hint passed to transcription, or the language it auto-detected
  transcript_json TEXT,                   -- raw word-level transcript, as returned by the transcription API — never edited in place
  captions_json TEXT,                     -- editable copy of transcript_json (word text/timing tweaks from the caption editor)
  style_id TEXT,                          -- preset id (MARKETING_STYLE_PRESETS in worker.js) or 'custom:<brand_style_id>'
  style_overrides_json TEXT,              -- per-project tweaks layered on top of the chosen style
  status TEXT NOT NULL DEFAULT 'uploading', -- uploading | uploaded | transcribing | ready | rendering | done | failed
  output_key TEXT,                        -- R2 key of the rendered clip, set by the render-complete webhook
  output_url TEXT,
  output_duration_sec REAL,
  watermarked INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_projects_client ON marketing_projects(client_id);

-- Saved brand styles ("custom brand style saving" — font/colors) on top of the built-in presets,
-- which need no table (MARKETING_STYLE_PRESETS is a static list in worker.js).
CREATE TABLE IF NOT EXISTS marketing_brand_styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,              -- {font, text_color, highlight_color, bg_style, position, animation}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_brand_styles_client ON marketing_brand_styles(client_id);

-- One row per background job (transcribe or render). Transcription runs inline within the
-- request (a single HTTP call to the transcription API — see handleMarketingTranscribe), so its
-- row is created and completed in the same request. Render jobs are genuinely async — created
-- here as 'queued'/'processing' and finished later by handleMarketingRenderWebhook, an external
-- render pipeline calling back in (see SETUP.md — Workers can't run ffmpeg).
CREATE TABLE IF NOT EXISTS marketing_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  type TEXT NOT NULL,                     -- transcribe | render
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | processing | done | failed
  progress_pct INTEGER NOT NULL DEFAULT 0,
  spec_json TEXT,                         -- the render spec sent to the external pipeline (trim, aspect, captions, style, flags)
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_marketing_jobs_project ON marketing_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_marketing_jobs_client ON marketing_jobs(client_id);
