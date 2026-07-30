-- Vendor Bills (SETUP.md "Accounting module — Vendor Bills") — the accounts-payable counterpart to
-- accounting_documents (which only ever models the client's OWN sales: Quotation/Invoice/Receipt).
-- A vendor bill is what a client's own supplier sent them, pushed to ERPNext as a Purchase Invoice
-- (bill_no/bill_date carry the vendor's own reference), then optionally a Payment Entry
-- (payment_type='Pay') once it's actually paid. Kept as its own table rather than folded into
-- accounting_documents — a Purchase Invoice needs a Supplier (not a Customer) and a Payable (not
-- Receivable) account, different enough master data that reusing the same table/columns would mean
-- overloading half of them with a second meaning depending on `type`.
CREATE TABLE IF NOT EXISTS accounting_vendor_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  company TEXT,
  supplier TEXT NOT NULL,
  erpnext_supplier TEXT,
  vendor_invoice_no TEXT,
  bill_date TEXT NOT NULL,
  due_date TEXT,
  line_items_json TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  subtotal REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  erpnext_payable_account TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  erpnext_doctype TEXT,
  erpnext_doc_name TEXT,
  erpnext_sync_status TEXT,
  erpnext_sync_error TEXT,
  erpnext_synced_at TEXT,
  erpnext_submitted_at TEXT,
  erpnext_payment_doc_name TEXT,
  erpnext_paid_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounting_vendor_bills_client ON accounting_vendor_bills(client_id, bill_date);
