-- Expense Entry (SETUP.md "Accounting module — Expense Entry") — a general "book an expense against
-- ERPNext" flow for the Accounting module's own "🧾 Documents" family of tabs, distinct from
-- Financial Planning's fp_expenses (which is purely local recurring/fixed-cost bookkeeping, never
-- pushed to ERPNext). Modeled as an ERPNext Journal Entry (company + expense account debit + a
-- paid-from cash/bank account credit) rather than Purchase Invoice/Expense Claim — a Journal Entry
-- needs only a Company and two GL Accounts, no Supplier/Employee master data has to exist first,
-- matching the simplest possible "pick a company, pick an expense account, enter an amount" flow.
CREATE TABLE IF NOT EXISTS accounting_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  company TEXT,
  expense_account TEXT NOT NULL,
  expense_account_name TEXT,
  paid_from_account TEXT,
  paid_from_account_name TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  expense_date TEXT NOT NULL,
  category TEXT,
  vendor TEXT,
  description TEXT,
  cost_center TEXT,
  status TEXT NOT NULL DEFAULT 'unsynced',
  erpnext_doctype TEXT,
  erpnext_doc_name TEXT,
  erpnext_sync_status TEXT,
  erpnext_sync_error TEXT,
  erpnext_synced_at TEXT,
  erpnext_submitted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounting_expenses_client ON accounting_expenses(client_id, expense_date);
