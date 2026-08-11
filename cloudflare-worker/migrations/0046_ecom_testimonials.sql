-- Ecommerce Testimonials module (Ecom → 🌟 Testimonials tab) — customer testimonials with an
-- optional photo/video, attached to specific products (product_ids JSON array; empty = applies
-- to every product). engineMaybeSendProductTestimonial (worker.js) sends the best-matching
-- testimonial's image/video the first time a customer's chat resolves to a specific product,
-- once per (lead, product) ever — ecom_testimonial_sent is the dedup record for that, same shape
-- as ecom_category_media_sent (migrations/0012_ecom_categories.sql).
CREATE TABLE IF NOT EXISTS ecom_testimonials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  product_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of ecom product NocoDB Ids; [] = every product
  image_url TEXT,
  video_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'inactive'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ecom_testimonials_client ON ecom_testimonials(client_id, status);

CREATE TABLE IF NOT EXISTS ecom_testimonial_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  testimonial_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_testimonial_sent_unique ON ecom_testimonial_sent(lead_id, product_id);
