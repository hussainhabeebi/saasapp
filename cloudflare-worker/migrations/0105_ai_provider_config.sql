-- Bring-your-own AI provider (Settings → Integrations → 🤖 AI Models). A client can connect their
-- own Claude / ChatGPT / Gemini / OpenRouter / Groq / DeepSeek / Mistral / any OpenAI-compatible
-- key, and the engine's text generation (bot replies, intent classifier, dashboard AI helpers) runs
-- on it instead of the shared Gemini key. No row (or enabled=0) means no behaviour change at all —
-- every existing client keeps running on the shared Gemini path exactly as before.
CREATE TABLE IF NOT EXISTS ai_provider_config (
  client_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,                     -- anthropic | openai | gemini | openrouter | groq | deepseek | mistral | custom
  base_url TEXT,                              -- only for provider=custom (OpenAI-compatible endpoint)
  model TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,                  -- AES-GCM with the AI_KEY_ENC_SECRET Worker secret; never sent back to the browser
  key_hint TEXT,                              -- last 4 characters, for display only
  enabled INTEGER NOT NULL DEFAULT 1,
  fallback_shared INTEGER NOT NULL DEFAULT 1, -- 1 = if the client's key fails, fall back to the shared Leadvyne AI
  last_ok_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
