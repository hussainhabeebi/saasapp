-- Marketing Studio module — Image Studio extras (SETUP.md "Marketing Studio module — Image Studio"):
-- a saved brand-style hint appended to every generate prompt, and prompt-hash caching on the image
-- log so a repeated "Generate a week" run (or any identical prompt) doesn't re-spend fal credits.
ALTER TABLE marketing_client_settings ADD COLUMN image_brand_style TEXT;
ALTER TABLE marketing_image_log ADD COLUMN prompt_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_marketing_image_log_hash ON marketing_image_log(client_id, kind, prompt_hash, created_at);
