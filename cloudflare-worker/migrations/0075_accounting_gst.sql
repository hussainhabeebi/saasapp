-- GST integration for the Accounting module.
-- Adds: tax-invoice flag, GST rate, CGST/SGST/IGST amounts, GSTINs, place of supply, supply type,
-- and reverse-charge indicator to accounting_documents; GSTIN + state code to fp_customers;
-- business GSTIN, state code, and default GST rate to fp_config.

ALTER TABLE accounting_documents ADD COLUMN is_tax_invoice INTEGER DEFAULT 0;
ALTER TABLE accounting_documents ADD COLUMN gst_rate_pct REAL DEFAULT 0;
ALTER TABLE accounting_documents ADD COLUMN cgst_amount REAL DEFAULT 0;
ALTER TABLE accounting_documents ADD COLUMN sgst_amount REAL DEFAULT 0;
ALTER TABLE accounting_documents ADD COLUMN igst_amount REAL DEFAULT 0;
ALTER TABLE accounting_documents ADD COLUMN supplier_gstin TEXT;
ALTER TABLE accounting_documents ADD COLUMN recipient_gstin TEXT;
ALTER TABLE accounting_documents ADD COLUMN place_of_supply TEXT;
ALTER TABLE accounting_documents ADD COLUMN supply_type TEXT DEFAULT 'B2C';
ALTER TABLE accounting_documents ADD COLUMN reverse_charge INTEGER DEFAULT 0;

ALTER TABLE fp_customers ADD COLUMN gstin TEXT;
ALTER TABLE fp_customers ADD COLUMN state_code TEXT;

ALTER TABLE fp_config ADD COLUMN business_gstin TEXT;
ALTER TABLE fp_config ADD COLUMN business_state_code TEXT;
ALTER TABLE fp_config ADD COLUMN default_gst_rate REAL DEFAULT 0;
