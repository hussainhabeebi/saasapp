-- Lets a document be tied to a real ERPNext Customer directly (picked from a live /erpnext/customers
-- list in accounting.html), instead of always resolving one by matching the linked lead's Name/Phone
-- (erpnextResolveCustomer in worker.js) — needed once a document isn't tied to any CRM lead at all,
-- e.g. one created from the new Customers tab for a walk-in/B2B customer that only exists in ERPNext.
-- When set, erpnextPushSalesDoc/erpnextPushPaymentEntry use this name as-is and skip the lead-based
-- resolve; when unset, behavior is unchanged from before this migration.
ALTER TABLE accounting_documents ADD COLUMN erpnext_customer TEXT;
