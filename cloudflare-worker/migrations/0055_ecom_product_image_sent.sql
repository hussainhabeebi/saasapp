-- Per-day, per-(lead, product) dedup for the Ecommerce module's product photo/media send —
-- engineClaimProductImageForToday (worker.js) INSERTs a row here the first time a customer's chat
-- resolves to a given product on a given calendar day; every later question about that same
-- product later the same day skips the photo/extra-angle-images/audio/video/PDF bundle and answers
-- with text only. Same shape as ecom_testimonial_sent (migrations/0046_ecom_testimonials.sql), but
-- date-scoped (sent_date) instead of once-ever, since re-showing the item the NEXT day is still
-- useful — only same-day repeats are the annoyance being deduped.
CREATE TABLE IF NOT EXISTS ecom_product_image_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  sent_date TEXT NOT NULL,   -- 'YYYY-MM-DD' (UTC) — the calendar day this product's media bundle was last sent to this lead
  sent_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_product_image_sent_unique ON ecom_product_image_sent(lead_id, product_id, sent_date);
