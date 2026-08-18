-- Adds choice_options to the ecom products mirror — a comma-separated list of tappable
-- WhatsApp button choices the bot presents when asking a customer to pick a variant (e.g.
-- "Red, Blue, Green" for a product that comes in multiple colors). Mirrors the same field
-- auto-provisioned in NocoDB via ensureEcomProductStyleFields / ECOM_STYLE_FIELD_TITLES.
ALTER TABLE ecom_products_mirror ADD COLUMN choice_options TEXT;
