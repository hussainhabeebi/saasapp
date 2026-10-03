-- Smart Follow-ups (LeadFollowupAgent Durable Objects) — one row per lead that has had its DO
-- spawned. The 15-min cron sweep (classicFollowupProcessClient) uses this to tell, for a client with
-- Smart Follow-ups enabled, which leads are already handled by a DO and which are not: any lead
-- without a row here is auto-migrated (its DO spawned) by the cron, or covered by the cron's own
-- send path if spawning fails — so a lead is never left with no follow-ups at all, which is what
-- happened before for every existing lead whose client never clicked "Migrate existing leads".
-- worker.js also creates this table lazily (ensureFollowupDoTable) so a deploy before this
-- migration is applied doesn't break the sweep.
CREATE TABLE IF NOT EXISTS followup_do_leads (
  lead_id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followup_do_leads_client ON followup_do_leads(client_id);
