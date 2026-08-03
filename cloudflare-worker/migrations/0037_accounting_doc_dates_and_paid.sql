-- Type-specific date fields for the now-separate Quotation and Invoice windows
-- (frontend/accounting.html) — a quotation cares about "valid until", an invoice about "due
-- date"; two columns rather than one generic "date" so each modal only shows the field relevant
-- to its own type.
ALTER TABLE accounting_documents ADD COLUMN valid_until TEXT;
ALTER TABLE accounting_documents ADD COLUMN due_date TEXT;

-- Marks that an Invoice's "mark as paid" transition has already auto-recorded its income
-- (a linked Receipt document) and collection (an fp_collections row) — see
-- fpRecordInvoicePaidSideEffects in worker.js. Idempotency guard: flipping an invoice's status
-- away from and back to 'paid' (e.g. a correction) must not double-book either one.
ALTER TABLE accounting_documents ADD COLUMN paid_recorded_at TEXT;
