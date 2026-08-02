-- Per-lead journal of Stage transitions driven by the Conversation Engine (worker.js
-- engineBuildLeadUpsertBody/handleEngineWebhook). The Leads table itself only ever keeps the
-- current Stage (overwritten on every change — see handleAiStageDurations's own comment on why
-- that table alone can only answer "how long has this lead been stuck right now", never "how long
-- did it actually spend in each stage historically"). This is a sidecar log purely for that
-- historical question — same "no other reader, D1-only" reasoning as coach_signals/
-- engine_event_log. Scoped to bot-driven transitions only (the moment engineBuildLeadUpsertBody
-- decides body.Stage!==state.stage); a rep manually dragging a Kanban card is a separate write
-- path this migration doesn't cover yet.
CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_history_lead ON stage_history(lead_id, at);
