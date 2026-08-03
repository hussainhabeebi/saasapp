-- Standalone Accounting module — plain local fields replacing the ERPNext-only ones now that
-- Documents/Expenses/Vendor Bills no longer require a Frappe Cloud connection to be usable.
-- The erpnext_* columns from earlier migrations stay in place untouched (still usable by anyone
-- who kept an ERPNext connection configured) — these are pure additions, not a rename.

-- Plain customer label for a Document not tied to a CRM lead (walk-in/one-off customer) — replaces
-- the old erpnext_customer picker, which only ever resolved against a connected ERPNext site.
ALTER TABLE accounting_documents ADD COLUMN customer_name TEXT;

-- Local "mark as paid" timestamp for a Vendor Bill (see handleVendorBillMarkPaid in worker.js) —
-- the standalone equivalent of the old erpnext_paid_at, set directly by the owner instead of by a
-- Payment Entry pushed to ERPNext.
ALTER TABLE accounting_vendor_bills ADD COLUMN paid_at TEXT;
