-- One-time migration: adds an optional Vercel project ID to property_website,
-- letting a website be mapped to a Vercel project so its Web Analytics data
-- can be queried server-side.

ALTER TABLE property_website ADD COLUMN IF NOT EXISTS vercel_project_id VARCHAR(100);
