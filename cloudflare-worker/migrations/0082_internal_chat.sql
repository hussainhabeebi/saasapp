-- Internal AI assistant chat history, one thread per client.
CREATE TABLE IF NOT EXISTS internal_chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL,
  role       TEXT    NOT NULL, -- 'user' | 'assistant'
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_internal_chat_client
  ON internal_chat(client_id, created_at);
