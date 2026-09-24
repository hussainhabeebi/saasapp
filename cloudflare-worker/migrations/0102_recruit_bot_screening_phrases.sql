-- Per-job phrases the WhatsApp bot uses when it tells an applicant they are (or are not) eligible.
-- GET /recruit/chat-screening scans the bot's replies in lead_messages for these (plus built-in
-- defaults like "not eligible" / "good to proceed") so the Recruitment module can list the chats
-- the bot already classified from its prompt as Eligible / Not Eligible, per job post.
-- One phrase per line, matched case-insensitively. Blank = defaults only.
ALTER TABLE recruit_jobs ADD COLUMN eligible_phrases TEXT;
ALTER TABLE recruit_jobs ADD COLUMN ineligible_phrases TEXT;
