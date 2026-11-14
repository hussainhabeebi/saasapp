-- Products & Services: a video link per item (Google Drive file → sent as a WhatsApp video when it
-- fits WhatsApp's 16 MB; a YouTube/other link, or a larger Drive video, is sent as a link).
-- Also added on first use by pcEnsureSchema (worker.js).
ALTER TABLE pc_items ADD COLUMN video_url TEXT;
