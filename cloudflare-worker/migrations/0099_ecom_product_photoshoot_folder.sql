-- Optional Google Drive photoshoot folder link per Ecom product (ecom.html "Photoshoot Folder
-- Link"). When a customer's message names the product, engineMaybeSendProductPhotoshoot
-- (worker.js) sends 5 random images from this folder in addition to the existing product media.
ALTER TABLE ecom_products_mirror ADD COLUMN photoshoot_folder_url TEXT;
