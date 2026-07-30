-- SaaS Ops: import Accounts from an existing NocoDB customers table (SETUP.md "SaaS Ops module —
-- importing from an existing NocoDB customers table"). Lets a client who already tracks their
-- customers in their own NocoDB table (rather than starting fresh in Financial Planning) point at
-- it and pull every row/column in — recognizable fields get mapped onto fp_customers' own columns,
-- everything else is kept verbatim so nothing from their existing table is silently dropped.

ALTER TABLE fp_config ADD COLUMN nocodb_customers_table_id TEXT;

-- nocodb_row_id makes re-running the import idempotent (upsert, not duplicate-create) — a plain
-- string rather than INTEGER since NocoDB's own `Id` is table-specific and this just needs to
-- round-trip unchanged, not be arithmetic. raw_nocodb_json is the full original row, so a column
-- this app doesn't know how to map (or a future need to look up something we didn't map) is never
-- lost — same "keep the source, don't just keep the derived fields" reasoning as
-- accounting_documents keeping erpnext_sync_error alongside the sync itself.
ALTER TABLE fp_customers ADD COLUMN nocodb_row_id TEXT;
ALTER TABLE fp_customers ADD COLUMN raw_nocodb_json TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_customers_nocodb_row_unique ON fp_customers(client_id, nocodb_row_id) WHERE nocodb_row_id IS NOT NULL;
