-- Tracks whether a synced ERPNext document has also been Submitted (Frappe's docstatus 0->1 —
-- the action that actually posts it to the ledger; a merely-synced document sits as an editable
-- Draft in ERPNext and doesn't count anywhere yet). See handleAccountingDocumentSubmitErpnext and
-- accounting.html's "📮 Publish" button — a separate, explicit action from Sync, since submitting
-- is one-way (a submitted Frappe document normally can't go back to Draft without a Cancel first).
ALTER TABLE accounting_documents ADD COLUMN erpnext_submitted_at TEXT;
