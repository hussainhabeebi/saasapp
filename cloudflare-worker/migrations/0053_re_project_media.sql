-- Real Estate project-level media (frontend/real-estate.html "New Project" modal) — brings
-- re_projects up to the same "5 images + video + PDF" shape re_units already has (migrations/0049)
-- and ecom products already have (ecom_products_mirror, migrations/0043). Same zero-storage-cost
-- design: merchants paste a Google Drive share link ("Anyone with the link can view") rather than
-- uploading a file — no new R2 bucket needed.
ALTER TABLE re_projects ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE re_projects ADD COLUMN image_url_2 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_projects ADD COLUMN image_url_3 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_projects ADD COLUMN image_url_4 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_projects ADD COLUMN image_url_5 TEXT NOT NULL DEFAULT '';
ALTER TABLE re_projects ADD COLUMN video_url TEXT NOT NULL DEFAULT '';
ALTER TABLE re_projects ADD COLUMN pdf_url TEXT NOT NULL DEFAULT '';
