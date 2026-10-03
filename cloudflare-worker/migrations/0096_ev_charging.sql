-- EV Charging Stations module tables

CREATE TABLE IF NOT EXISTS ev_charging_stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  charger_type TEXT CHECK(charger_type IN ('AC Level 1','AC Level 2','DC Fast','DC Ultra Fast','Portable','')),
  connector_types TEXT DEFAULT '[]',
  power_kw REAL,
  voltage TEXT,
  current_type TEXT CHECK(current_type IN ('AC','DC','')),
  phases TEXT CHECK(phases IN ('Single Phase','Three Phase','')),
  suitable_for TEXT DEFAULT '[]',
  warranty_years INTEGER DEFAULT 1,
  installation_type TEXT CHECK(installation_type IN ('Wall Mount','Pedestal','Portable','Pole Mount','')),
  outdoor_rated INTEGER DEFAULT 0,
  smart_features TEXT DEFAULT '[]',
  price REAL,
  price_currency TEXT DEFAULT 'INR',
  stock_qty INTEGER DEFAULT 0,
  sku TEXT,
  image_url TEXT,
  description TEXT,
  datasheet_url TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','discontinued')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ev_consumables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT CHECK(category IN ('Cable','Connector','Adapter','Plug','Mounting Hardware','Protection Gear','Spare Part','Accessory','Other','')),
  brand TEXT,
  compatible_with TEXT DEFAULT '[]',
  cable_length_m REAL,
  connector_standard TEXT,
  max_current_a REAL,
  max_power_kw REAL,
  ip_rating TEXT,
  material TEXT,
  color TEXT,
  price REAL,
  price_currency TEXT DEFAULT 'INR',
  stock_qty INTEGER DEFAULT 0,
  sku TEXT,
  image_url TEXT,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','discontinued')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ev_charging_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  order_number TEXT NOT NULL,
  lead_id TEXT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  customer_address TEXT,
  order_type TEXT DEFAULT 'sale' CHECK(order_type IN ('sale','quote','installation','service')),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','confirmed','processing','dispatched','delivered','installed','cancelled','refunded')),
  subtotal REAL DEFAULT 0,
  discount REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  total REAL DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  payment_status TEXT DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','partial','paid','refunded')),
  payment_method TEXT,
  installation_required INTEGER DEFAULT 0,
  installation_date TEXT,
  installation_address TEXT,
  installer_name TEXT,
  site_survey_done INTEGER DEFAULT 0,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ev_charging_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES ev_charging_orders(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('station','consumable')),
  item_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  sku TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  discount REAL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ev_charging_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT UNIQUE NOT NULL,
  business_name TEXT,
  default_currency TEXT DEFAULT 'INR',
  tax_label TEXT DEFAULT 'GST',
  tax_rate_pct REAL DEFAULT 18,
  include_installation_by_default INTEGER DEFAULT 0,
  installation_charge REAL DEFAULT 0,
  order_prefix TEXT DEFAULT 'EVC',
  low_stock_threshold INTEGER DEFAULT 5,
  show_consumables_in_chat INTEGER DEFAULT 1,
  show_stations_in_chat INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ev_stations_client   ON ev_charging_stations(client_id);
CREATE INDEX IF NOT EXISTS idx_ev_stations_status   ON ev_charging_stations(client_id, status);
CREATE INDEX IF NOT EXISTS idx_ev_consumables_client ON ev_consumables(client_id);
CREATE INDEX IF NOT EXISTS idx_ev_consumables_cat   ON ev_consumables(client_id, category);
CREATE INDEX IF NOT EXISTS idx_ev_orders_client     ON ev_charging_orders(client_id);
CREATE INDEX IF NOT EXISTS idx_ev_orders_status     ON ev_charging_orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_ev_orders_number     ON ev_charging_orders(client_id, order_number);
CREATE INDEX IF NOT EXISTS idx_ev_order_items_order ON ev_charging_order_items(order_id);
