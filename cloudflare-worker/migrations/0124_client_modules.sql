-- Per-client module switches set by the Leadvyne admin, kept in D1 instead of a NocoDB column.
-- accounting_enabled: 1 = the Accounting module (accounting.html, /accounting/ledger/*, the
-- accounting daily jobs) is on for this client. A client with no row falls back to the legacy
-- NocoDB clients.accounting_enabled value once, which is then copied here (worker.js
-- isAccountingEnabled). Also created lazily by the Worker, so applying this is optional.
CREATE TABLE IF NOT EXISTS client_modules (
  client_id INTEGER PRIMARY KEY,
  accounting_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
