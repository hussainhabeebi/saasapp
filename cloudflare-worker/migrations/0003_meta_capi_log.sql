-- Meta Ads ROI Report (Team -> Reports page) — see SETUP.md "Meta Ads ROI Report". Logs every
-- CAPI event actually sent to Meta (sendMetaCapiEvent previously fired-and-forgot with no record
-- anywhere), so the Reports page can show "events actually sent" as an audit trail distinct from
-- the CRM's own conversion counts (allLeads), and so a client can sanity-check CAPI is really
-- firing rather than silently no-op'ing (e.g. pixel/token unset, or Meta rejecting the event).
CREATE TABLE IF NOT EXISTS meta_capi_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  lead_id INTEGER,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_capi_events_client ON meta_capi_events(client_id, sent_at);
