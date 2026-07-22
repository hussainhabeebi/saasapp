-- Human Deals "🧭 Coach" panel — a per-turn log of Sentiment/LastObjectionCategory (both already
-- computed by the engine on every inbound message, but only the latest value is kept on the Leads
-- row itself) so a rep/manager can see a running timeline of where a chat started going sideways,
-- not just its current snapshot. No other part of the app needs this history, so it lives here
-- rather than as more NocoDB columns — same "sidecar data with no other reader" reasoning as the
-- Review Request/Referral/Follow-up Engine D1 tables.
CREATE TABLE IF NOT EXISTS coach_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  sentiment TEXT,
  objection_category TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coach_signals_lead ON coach_signals(lead_id, at);
