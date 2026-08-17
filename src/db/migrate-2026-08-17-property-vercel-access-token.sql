-- One-time migration: stores the installation access token from a
-- property's Vercel connection. Scope is "Projects: Read" only (confirmed
-- can't read Web Analytics), used to list that property's own connected
-- account's projects by name for the website-mapping picker.

ALTER TABLE property ADD COLUMN IF NOT EXISTS vercel_access_token TEXT;
