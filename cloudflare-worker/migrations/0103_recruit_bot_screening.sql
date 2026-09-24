-- Bot eligibility verdicts found in OLDER chats — ones that predate lead_messages and only live in
-- the NocoDB lead's ConvHistory JSON (no per-message timestamps, so they can't be seeded into
-- lead_messages without faking ts). Filled by POST /recruit/chat-screening/backfill ("Scan older
-- chats" in the Recruitment → Bot Screened tab) and merged into GET /recruit/chat-screening for
-- leads that have no verdict in lead_messages. The worker also creates this table on first use.
CREATE TABLE IF NOT EXISTS recruit_bot_screening (
  client_id  INTEGER NOT NULL,
  lead_id    INTEGER NOT NULL,
  verdict    TEXT    NOT NULL,
  job_id     INTEGER,
  message    TEXT,
  ts         TEXT,
  scanned_at TEXT    NOT NULL,
  PRIMARY KEY (client_id, lead_id)
);
