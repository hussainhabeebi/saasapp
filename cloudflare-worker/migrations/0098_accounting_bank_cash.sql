-- Bank & Cash Account master, Payment Entries as first-class records, and Bank Reconciliation.
-- Connects the existing accounting_documents / accounting_expenses / accounting_vendor_bills /
-- fp_collections flow to named bank/cash accounts with a running balance, and adds structured
-- payment entries so every money-movement is traceable to a specific account.
-- All tables follow the same client_id-scoped, plain-integer-reference (no SQL foreign keys)
-- convention used throughout this app.

-- Named Bank or Cash account master — the "paid from / paid to" account for every payment.
CREATE TABLE IF NOT EXISTS acc_bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bank',   -- 'bank' | 'cash'
  bank_name TEXT,
  account_number TEXT,
  ifsc_code TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  opening_balance REAL NOT NULL DEFAULT 0,
  opening_balance_date TEXT,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_bank_accounts_client ON acc_bank_accounts(client_id);

-- Payment Entry — a first-class record for every money movement linked to an account.
-- payment_type: 'receive' (money in) | 'pay' (money out)
-- source_type / source_id trace back to the originating document:
--   'receipt'     → accounting_documents (type='receipt')
--   'expense'     → accounting_expenses
--   'vendor_bill' → accounting_vendor_bills
--   'collection'  → fp_collections
--   'manual'      → ad-hoc entry (bank charges, opening balance adjustment, etc.)
CREATE TABLE IF NOT EXISTS acc_payment_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  payment_type TEXT NOT NULL DEFAULT 'receive',
  payment_date TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'INR',
  account_id INTEGER,
  account_name TEXT,
  mode TEXT NOT NULL DEFAULT 'bank',   -- 'bank'|'upi'|'cash'|'cheque'|'card'|'other'
  reference_no TEXT,
  party_type TEXT,                      -- 'customer' | 'supplier'
  party_id INTEGER,
  party_name TEXT,
  source_type TEXT,
  source_id INTEGER,
  description TEXT,
  is_reconciled INTEGER NOT NULL DEFAULT 0,
  reconciled_at TEXT,
  recon_session_id INTEGER,
  recon_line_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_payment_entries_client ON acc_payment_entries(client_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_acc_payment_entries_account ON acc_payment_entries(account_id);

-- Bank reconciliation session — one uploaded bank statement per account.
CREATE TABLE IF NOT EXISTS acc_bank_recon_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  account_name TEXT,
  statement_from TEXT,
  statement_to TEXT,
  closing_balance REAL,
  currency TEXT,
  total_lines INTEGER NOT NULL DEFAULT 0,
  matched_lines INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'in_progress'|'completed'
  upload_filename TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_bank_recon_sessions_client ON acc_bank_recon_sessions(client_id);

-- Individual transaction line parsed from an uploaded bank statement.
-- amount: positive = credit (money in), negative = debit (money out) — from the bank's perspective.
CREATE TABLE IF NOT EXISTS acc_bank_recon_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  txn_date TEXT,
  description TEXT,
  amount REAL,
  balance REAL,
  reference TEXT,
  match_status TEXT NOT NULL DEFAULT 'unmatched',  -- 'unmatched'|'matched'|'ignored'
  matched_payment_entry_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_bank_recon_lines_session ON acc_bank_recon_lines(session_id);

-- Link existing records back to payment entries (optional, non-FK).
ALTER TABLE accounting_documents ADD COLUMN payment_entry_id INTEGER;
ALTER TABLE accounting_expenses ADD COLUMN payment_entry_id INTEGER;
ALTER TABLE accounting_vendor_bills ADD COLUMN payment_entry_id INTEGER;
