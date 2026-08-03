-- Interconnects Customers/Suppliers across Documents, Expense Entry, Vendor Bills and Financial
-- Planning, plus a single account-wide default currency — see SETUP.md "Accounting module" for
-- the full picture. All additions are nullable/optional: existing free-text customer_name/
-- supplier/vendor values keep working exactly as before for anyone who doesn't pick a master
-- record, same "plain integer reference, not a SQL foreign key" convention used throughout this
-- app (a document/bill must still resolve even if the linked customer/supplier is later deleted).

-- One place to set "what currency does this business run in" — read by the frontend as the
-- default for every currency field across Documents/Expense Entry/Vendor Bills/Financial
-- Planning, instead of each modal hardcoding its own fallback ('AED' here, 'INR' there). Still
-- just a default, not an enforced single-currency constraint — every currency field stays a free
-- text input, same as before.
ALTER TABLE fp_config ADD COLUMN default_currency TEXT;

-- Suppliers master — the accounts-payable mirror of fp_customers, so Vendor Bills and Expense
-- Entry's "vendor paid" can reference the same supplier record instead of each retyping a name
-- with no shared identity between them.
CREATE TABLE IF NOT EXISTS fp_suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_suppliers_client ON fp_suppliers(client_id);

ALTER TABLE accounting_vendor_bills ADD COLUMN supplier_id INTEGER;
ALTER TABLE accounting_expenses ADD COLUMN supplier_id INTEGER;

-- Documents' customer, linked to the same fp_customers master Financial Planning already uses —
-- customer_name (migration 0035) stays as the plain-text display fallback for a document created
-- before this migration, or one deliberately left unlinked.
ALTER TABLE accounting_documents ADD COLUMN customer_id INTEGER;
