-- Follow-up Engine (SETUP.md "Campaigns module" — Follow-up Engine tab) — adds an optional media
-- attachment (video/image/audio/PDF, pasted as a Google Drive share link) per follow-up variant,
-- sent as a real attachment alongside the variant's text via sendDriveMediaToChatwoot
-- (cloudflare-worker/worker.js), the same "paste a Drive link, fetch+forward the real bytes"
-- convention as Hospitality/Ecom Categories media. Additive-only ALTER on the existing
-- followup_variants table from migrations/0007_followup_engine.sql — no rewrite, no data loss for
-- existing variants (both columns default to '', meaning "no media attached").

ALTER TABLE followup_variants ADD COLUMN media_url TEXT NOT NULL DEFAULT '';
ALTER TABLE followup_variants ADD COLUMN media_caption TEXT NOT NULL DEFAULT '';
