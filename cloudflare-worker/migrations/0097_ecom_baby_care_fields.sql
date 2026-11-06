-- Adds baby_care style columns to the ecom products mirror table.
-- These fields are specific to the Baby Care & Apparel product style and are
-- used by the button-led baby care chat flow (fabric quality tier, age group,
-- set contents and accent colour options).
ALTER TABLE ecom_products_mirror ADD COLUMN age_group TEXT;
ALTER TABLE ecom_products_mirror ADD COLUMN fabric_type TEXT;
ALTER TABLE ecom_products_mirror ADD COLUMN set_includes TEXT;
ALTER TABLE ecom_products_mirror ADD COLUMN accent_colors TEXT;
