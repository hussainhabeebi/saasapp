-- Durable backup of ecom product writes (SETUP.md "Ecommerce products"). NocoDB (see
-- ecomResolveTable/handleEcomCreate/handleEcomUpdate in worker.js) stays the source of truth that
-- ecom.html reads from — this is a mirror only, upserted from ecomVerifyProductWrite right after it
-- re-reads the record NocoDB actually persisted (post any column-type self-heal), so a client whose
-- NocoDB base gets misconfigured, wiped, or unreachable still has every product's data recoverable
-- from our own D1 instead of gone with nothing to restore from.
CREATE TABLE IF NOT EXISTS ecom_products_mirror (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  nocodb_id INTEGER NOT NULL,
  name TEXT,
  sku TEXT,
  category TEXT,
  style TEXT,
  color TEXT,
  size TEXT,
  shade TEXT,
  skin_type TEXT,
  expiry_date TEXT,
  hair_type TEXT,
  concern TEXT,
  volume_ml TEXT,
  ingredient TEXT,
  brand TEXT,
  variant TEXT,
  warranty_period TEXT,
  shopify_product_url TEXT,
  product_link TEXT,
  price REAL,
  currency TEXT,
  stock INTEGER,
  status TEXT,
  image_url TEXT,
  audio_url TEXT,
  video_url TEXT,
  pdf_url TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_products_mirror_unique ON ecom_products_mirror(client_id, nocodb_id);
