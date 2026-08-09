-- Ecommerce Promotions & Offers module (Ecom → 🎁 Promotions tab) — lets a shop owner define a
-- promo code with a description, a dedicated reply, which products it applies to (optional —
-- blank means storewide), and Google Drive-linked image/audio/video, same link convention as
-- product/category media elsewhere in this module. engineMaybeSendPromoOffer (worker.js) matches
-- a customer's message against active codes (or generic "offer/discount/coupon" wording) and
-- replies with reply_text plus whichever of image_url/audio_url/video_url are set.
CREATE TABLE IF NOT EXISTS ecom_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reply_text TEXT NOT NULL DEFAULT '',
  product_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of ecom product NocoDB Ids; [] = applies to every product
  image_url TEXT,
  audio_url TEXT,
  video_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'inactive'
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecom_promotions_client_code ON ecom_promotions(client_id, code);
CREATE INDEX IF NOT EXISTS idx_ecom_promotions_client ON ecom_promotions(client_id, status);
