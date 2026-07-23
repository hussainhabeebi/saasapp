-- Ecommerce product categories (SETUP.md "Ecommerce categories") — `category` on a product row has
-- always been a free-text field (frontend/ecom.html); this adds a proper entity so a category can
-- carry its own photos, auto-sent to chat the first time a customer's message names that category
-- — separate from and in addition to the existing per-product image-on-enquiry send
-- (engineDeliverReply's imageUrl:product.image_url path, untouched by this feature).
CREATE TABLE IF NOT EXISTS ecom_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  image_url_1 TEXT,
  image_url_2 TEXT,
  image_url_3 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ecom_categories_client ON ecom_categories(client_id);

CREATE TABLE IF NOT EXISTS ecom_category_media_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_category_media_sent_unique ON ecom_category_media_sent(lead_id, category_id);
