-- CEO Bot (cloudflare-worker/ceo-bot.js) — an add-on on top of the Projects module: an AI
-- operations manager for staff tasks that talks to the account owner and staff on its own,
-- dedicated WhatsApp number. Never touches leads or the lead-reply engine.
-- Only runs for clients whose CLIENTS.ceo_bot_enabled is 'Yes' (set by the super-admin), and only
-- the account owner can open or configure it. Every table here is new; nothing existing changes.

-- One row per client: settings JSON + the dedicated WhatsApp number's credentials.
-- wa_token_enc / app_secret_enc are AES-GCM encrypted (same scheme as AI provider keys).
-- hook_key is the unguessable path segment + verify token of this client's webhook URL.
CREATE TABLE IF NOT EXISTS ceo_bot_settings (
  client_id INTEGER PRIMARY KEY,
  config_json TEXT NOT NULL DEFAULT '{}',
  wa_phone_id TEXT NOT NULL DEFAULT '',
  display_phone TEXT NOT NULL DEFAULT '',
  wa_token_enc TEXT NOT NULL DEFAULT '',
  app_secret_enc TEXT NOT NULL DEFAULT '',
  hook_key TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ceo_bot_settings_hook ON ceo_bot_settings(hook_key);

-- Every message on the CEO number, both directions. Only ever shown to the account owner.
CREATE TABLE IF NOT EXISTS ceo_bot_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  party_email TEXT NOT NULL DEFAULT '',
  party_role TEXT NOT NULL DEFAULT '',     -- admin | staff | unknown
  direction TEXT NOT NULL DEFAULT 'out',   -- in | out
  kind TEXT NOT NULL DEFAULT '',           -- brief | standup | reminder | escalation | wrap | weekly | recognition | reply | chat | action | test
  body TEXT NOT NULL DEFAULT '',
  task_id INTEGER,
  status TEXT NOT NULL DEFAULT '',         -- sent | failed | skipped | received
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ceo_bot_messages_thread ON ceo_bot_messages(client_id, phone, id);
CREATE INDEX IF NOT EXISTS idx_ceo_bot_messages_client ON ceo_bot_messages(client_id, created_at);

-- Per phone: when they last wrote in (WhatsApp 24-hour window) and short conversation context.
CREATE TABLE IF NOT EXISTS ceo_bot_contacts (
  client_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  last_inbound_at TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (client_id, phone)
);

-- Once-only guard for scheduled sends (brief per day, escalation per task per due date, …).
CREATE TABLE IF NOT EXISTS ceo_bot_runs (
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  run_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, kind, run_key)
);

-- Changes the bot proposed (approval inbox) or made, with who decided and the result.
CREATE TABLE IF NOT EXISTS ceo_bot_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                      -- update_task | create_task | message_staff
  payload_json TEXT NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | executed | rejected | failed
  requested_via TEXT NOT NULL DEFAULT '',  -- whatsapp | console
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ceo_bot_actions_status ON ceo_bot_actions(client_id, status, id);

-- Daily standup answers from staff.
CREATE TABLE IF NOT EXISTS ceo_bot_standups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  member_email TEXT NOT NULL,
  standup_date TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  asked_at TEXT NOT NULL DEFAULT '',
  answered_at TEXT NOT NULL DEFAULT '',
  UNIQUE (client_id, member_email, standup_date)
);

-- Task updates staff sent through the bot, and reminders/escalations it sent — feeds Team reports.
CREATE TABLE IF NOT EXISTS ceo_bot_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  task_id INTEGER,
  member_email TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,                     -- done | blocked | delay | progress | reminded | escalated
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ceo_bot_task_events_client ON ceo_bot_task_events(client_id, created_at);

-- AI calls per month, for the monthly cap.
CREATE TABLE IF NOT EXISTS ceo_bot_usage (
  client_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  ai_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, month)
);
