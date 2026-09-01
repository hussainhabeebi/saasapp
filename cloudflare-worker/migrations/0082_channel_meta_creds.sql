-- Per-inbox Meta (WhatsApp Business) credential cache.
-- Populated automatically during Embedded Signup connect and via the per-channel
-- "Detect credentials" button; used by the Campaigns module to pick the right
-- waba_id / wa_phone_id when a client has more than one WhatsApp inbox.
CREATE TABLE IF NOT EXISTS channel_meta_creds (
  client_id       INTEGER NOT NULL,
  inbox_id        INTEGER NOT NULL,
  waba_id         TEXT    NOT NULL DEFAULT '',
  wa_phone_id     TEXT    NOT NULL DEFAULT '',
  wa_token        TEXT    NOT NULL DEFAULT '',
  wa_display_phone TEXT   NOT NULL DEFAULT '',
  detected_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (client_id, inbox_id)
);
