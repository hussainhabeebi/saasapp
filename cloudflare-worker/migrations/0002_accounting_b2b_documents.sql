-- B2B module (frontend/b2b.html) and Accounting module (frontend/accounting.html) — see
-- SETUP.md for both modules' full description. Brand/Country/b2b_events stay on NocoDB's LEADS
-- table (every existing lead view — kanban, lead list, exports, Team Performance — already reads
-- those out of NocoDB), and quote_number_seq/invoice_number_seq stay on NocoDB's CLIENTS table
-- (a general per-client counter pattern shared with other modules, e.g. itin_number_seq) — only
-- the Documents themselves move here, same "sidecar data with no other NocoDB reader" reasoning
-- as 0001_reviews_referrals.sql.

-- B2B Smart Documents — quotes/catalogs with a trackable public link (public_slug) and
-- click-to-accept. id is a real autoincrement primary key (unlike NocoDB's own auto Id, which the
-- Worker's JSON responses still expose as "Id" to keep frontend/b2b.html's existing contract).
CREATE TABLE IF NOT EXISTS b2b_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER,
  type TEXT NOT NULL DEFAULT 'quote',
  title TEXT,
  brand TEXT,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  currency TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  public_slug TEXT NOT NULL UNIQUE,
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_b2b_documents_client ON b2b_documents(client_id);

-- Accounting Quotation -> Invoice -> Receipt lifecycle, with optional one-way ERPNext push.
-- linked_doc_id chains a converted document back to its source (e.g. an invoice back to the
-- quotation it was converted from) — a plain integer reference, not a SQL foreign key, since a
-- receipt's linked invoice needs to still resolve even if line items etc. differ across the chain.
CREATE TABLE IF NOT EXISTS accounting_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER,
  type TEXT NOT NULL DEFAULT 'quotation',
  title TEXT,
  line_items_json TEXT NOT NULL DEFAULT '[]',
  currency TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  tax_pct REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  linked_doc_id INTEGER,
  notes TEXT,
  erpnext_doctype TEXT,
  erpnext_doc_name TEXT,
  erpnext_sync_status TEXT,
  erpnext_sync_error TEXT,
  erpnext_synced_at TEXT,
  doc_created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounting_documents_client ON accounting_documents(client_id);
CREATE INDEX IF NOT EXISTS idx_accounting_documents_lead ON accounting_documents(client_id, lead_id);
