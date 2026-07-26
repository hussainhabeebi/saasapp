-- Marketing Studio module — client-level API keys (SETUP.md "Marketing Studio module — Client
-- API keys"). Pexels/Pixabay/Freesound/fal.ai calls default to the render pipeline's own shared
-- Coolify env vars (existing behavior, unchanged) — this table lets a client optionally bring
-- their own key instead, e.g. so their own fal.ai spend is billed to them, not the shared account.
-- A NULL column here just means "use the shared default", not "feature disabled".
CREATE TABLE IF NOT EXISTS marketing_client_settings (
  client_id INTEGER PRIMARY KEY,
  pexels_api_key TEXT,
  pixabay_api_key TEXT,
  freesound_api_key TEXT,
  fal_api_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
