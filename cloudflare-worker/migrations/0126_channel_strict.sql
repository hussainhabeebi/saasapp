-- Channels → Connected Channels → 🔒 Strict: a strict channel's leads and chats are visible only to
-- its assigned user and the account owner — admins and general managers included in the hiding.
-- (bot_reply_disabled is added at runtime by ensureInboxAssignmentsTable; both are repeated there.)
ALTER TABLE channel_inbox_assignments ADD COLUMN strict INTEGER NOT NULL DEFAULT 0;
