-- Marketing Studio module — Content Calendar & Instagram Auto-Posting (SETUP.md "Marketing
-- Studio module — Content Calendar & Instagram Auto-Posting"): plan a post (an image + caption),
-- optionally schedule it, and have it actually go out to Instagram once a human approves it. Same
-- D1-not-NocoDB reasoning as the rest of this module — a genuinely new data shape with no
-- existing NocoDB reader.
CREATE TABLE IF NOT EXISTS marketing_content_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  title TEXT,
  caption TEXT,
  image_key TEXT,                        -- R2 object key (MARKETING_MEDIA bucket) — generated or edited via fal.ai
  platform TEXT NOT NULL DEFAULT 'instagram',
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | posted | failed
  scheduled_at TEXT,                     -- ISO datetime this post should go out; NULL = unscheduled draft
  approved_at TEXT,                      -- non-NULL = a human explicitly approved auto-posting. The
                                          -- publish sweep (runMarketingContentPublishSweepForAllClients
                                          -- in worker.js) never posts anything without this set, no
                                          -- matter how overdue scheduled_at is — the approval gate is a
                                          -- WHERE-clause condition, not just a UI check.
  gcal_event_id TEXT,                    -- pushed to the client's existing Google Calendar connection
                                          -- (gcal_refresh_token/gcal_calendar_id) when scheduled_at is set
  ig_media_id TEXT,                      -- Instagram media id, set once actually posted
  error TEXT,                            -- last publish failure, if status='failed'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketing_content_posts_client ON marketing_content_posts(client_id);
-- Matches the publish sweep's WHERE clause (status, approved_at, scheduled_at) so that query stays
-- an index scan instead of a full table scan as this table grows.
CREATE INDEX IF NOT EXISTS idx_marketing_content_posts_due ON marketing_content_posts(status, approved_at, scheduled_at);

-- Brand logo for Image Studio "incorporate our logo" edits — one per client, alongside the
-- existing bring-your-own-API-key fields already on this settings row (0022_marketing_client_settings.sql).
ALTER TABLE marketing_client_settings ADD COLUMN logo_key TEXT;
