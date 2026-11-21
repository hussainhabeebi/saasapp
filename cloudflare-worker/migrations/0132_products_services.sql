-- Products & Services for General accounts (product-catalog.js, frontend/products-services.html):
-- what the account sells, with full details, a price and Google Drive links for photos, a voice
-- note and a brochure. The bot sends an item's details and media when a customer names it, once
-- per lead per item per day (pc_media_sent); Chats → AI Proposal builds proposals from it.
-- Also created on first use by pcEnsureSchema (worker.js).
CREATE TABLE IF NOT EXISTS pc_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product',
  name TEXT NOT NULL,
  category TEXT,
  sku TEXT,
  short_description TEXT,
  details TEXT,
  features TEXT,
  keywords TEXT,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'INR',
  price_unit TEXT,
  image_url_1 TEXT,
  image_url_2 TEXT,
  image_url_3 TEXT,
  image_url_4 TEXT,
  image_url_5 TEXT,
  voice_note_url TEXT,
  brochure_url TEXT,
  auto_send INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pc_items_client ON pc_items(client_id, status);
CREATE TABLE IF NOT EXISTS pc_media_sent (
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (lead_id, item_id)
);
