-- Public chat page: per-client shareable tokens and message history.
-- One token = one shareable link (chat.leadvyne.com?t=TOKEN).
-- Clients generate tokens from Settings → Chat Page; each token maps to their client_id.
-- Messages are keyed by (token, session_id) where session_id is a UUID stored in the
-- visitor's localStorage — conversations survive page refreshes but not device switches.
CREATE TABLE IF NOT EXISTS chat_tokens (
  token       TEXT PRIMARY KEY,
  client_id   INTEGER NOT NULL,
  label       TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS public_chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token       TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  role        TEXT    NOT NULL, -- 'user' | 'bot'
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pcm_lookup
  ON public_chat_messages(token, session_id, created_at);
