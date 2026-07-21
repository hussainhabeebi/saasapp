-- Company + Debtors Account for the ERPNext Document modal (accounting.html) — both picked from a
-- live ERPNext list (GET /erpnext/companies, GET /erpnext/accounts) rather than typed freehand,
-- since a mismatched company/account name on the ERPNext side is a silent, confusing sync failure
-- otherwise. company is passed through to every synced doctype (Quotation/Sales Invoice/Payment
-- Entry all accept it); erpnext_debtors_account only applies to Sales Invoice (`debit_to`) and
-- Payment Entry (`paid_from`) — see erpnextPushSalesDoc/erpnextPushPaymentEntry in worker.js.
ALTER TABLE accounting_documents ADD COLUMN company TEXT;
ALTER TABLE accounting_documents ADD COLUMN erpnext_debtors_account TEXT;
