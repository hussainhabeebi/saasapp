-- Fast, near-atomic dedup gate for handleEngineWebhook (SETUP.md "Conversation Engine" —
-- double-reply fix). A single UNIQUE-indexed INSERT, checked before any NocoDB round trip, to
-- close the race window the existing LastProcessedMessageId/engineClaimMessage mechanism still
-- has: that check reads/writes NocoDB across several round trips deep into a turn, so a
-- redelivery of the same message_created event (Chatwoot's Agent Bot integration timing out and
-- retrying) can race ahead of the first delivery's claim and independently run the full
-- classify/LLM/reply pipeline — observed live as two differently-phrased AI replies to the same
-- inbound message.
CREATE TABLE IF NOT EXISTS engine_processed_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_processed_messages_unique ON engine_processed_messages(client_id, message_id);
