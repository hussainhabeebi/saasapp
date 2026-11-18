-- Click-to-WhatsApp ad clicks (ctwa_clid + ad id) seen before the contact's lead row existed.
-- Written by engineCaptureAdClickEarly, applied and deleted on the lead's first save
-- (engineFlushPendingAdClick). Also created on first use.
CREATE TABLE IF NOT EXISTS engine_pending_ad_clicks (
  client_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  data TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (client_id, phone)
);
