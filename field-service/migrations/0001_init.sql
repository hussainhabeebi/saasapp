-- Field Service module — standalone schema, own D1 database (see ../wrangler.toml).
-- Not shared with cloudflare-worker/'s D1 or NocoDB tables — this module owns its full dataset.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE,
  custom_domain TEXT UNIQUE,
  currency TEXT NOT NULL DEFAULT 'AED',
  tax_mode TEXT NOT NULL DEFAULT 'vat',        -- vat | gst | none
  tax_rate REAL NOT NULL DEFAULT 5,
  tax_label TEXT NOT NULL DEFAULT 'VAT',
  cancellation_fee_type TEXT NOT NULL DEFAULT 'flat', -- flat | percent
  cancellation_fee_value REAL NOT NULL DEFAULT 0,
  cancellation_window_hours INTEGER NOT NULL DEFAULT 24,
  plan TEXT NOT NULL DEFAULT 'trial',
  trial_ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',          -- owner | manager | staff
  name TEXT NOT NULL,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, email)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  notes TEXT,
  portal_token TEXT UNIQUE,                    -- link-based self-service portal access, see /api/portal/:token
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_customers_portal_token ON customers(portal_token);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  assigned_staff_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'requested',    -- requested|scheduled|en_route|in_progress|completed|cancelled
  scheduled_start TEXT,
  scheduled_end TEXT,
  address TEXT,
  lat REAL,
  lng REAL,
  price_estimate REAL,
  cancellation_fee_charged REAL NOT NULL DEFAULT 0,
  cancelled_reason TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jobs_tenant ON jobs(tenant_id);
CREATE INDEX idx_jobs_staff ON jobs(assigned_staff_id);
CREATE INDEX idx_jobs_status ON jobs(tenant_id, status);

CREATE TABLE job_status_history (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id),
  note TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_job_status_history_job ON job_status_history(job_id);

CREATE TABLE gps_checkins (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  staff_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                          -- check_in | check_out
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  accuracy_m REAL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_gps_checkins_job ON gps_checkins(job_id);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_id TEXT REFERENCES jobs(id),
  status TEXT NOT NULL DEFAULT 'draft',        -- draft|sent|accepted|declined
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  notes TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_quotes_tenant ON quotes(tenant_id);

CREATE TABLE quote_items (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_quote_items_quote ON quote_items(quote_id);

CREATE TABLE recurring_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  frequency TEXT NOT NULL,                     -- weekly|biweekly|monthly
  amount REAL NOT NULL DEFAULT 0,
  next_run_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recurring_plans_tenant ON recurring_plans(tenant_id);
CREATE INDEX idx_recurring_plans_due ON recurring_plans(active, next_run_date);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_id TEXT REFERENCES jobs(id),
  quote_id TEXT REFERENCES quotes(id),
  recurring_plan_id TEXT REFERENCES recurring_plans(id),
  status TEXT NOT NULL DEFAULT 'unpaid',       -- unpaid|partial|paid|overdue|cancelled
  subtotal REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'AED',
  due_date TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX idx_invoices_status ON invoices(tenant_id, status);

CREATE TABLE invoice_items (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',         -- cash|card|bank_transfer|other
  reference TEXT,
  recorded_by TEXT REFERENCES users(id),
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_payments_tenant ON payments(tenant_id);

CREATE TABLE parts_inventory (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  sku TEXT,
  unit_cost REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  qty_on_hand REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_parts_tenant ON parts_inventory(tenant_id);

CREATE TABLE job_parts_used (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  part_id TEXT NOT NULL REFERENCES parts_inventory(id),
  qty REAL NOT NULL DEFAULT 1,
  unit_cost REAL NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_job_parts_used_job ON job_parts_used(job_id);
