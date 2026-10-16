-- One-time migration: one QuickBooks Online company per organization (the
-- group keeps one set of books; split a site out with a QBO Location or
-- Class). The app's Client ID/Secret live in .env, not here -- these are the
-- per-org OAuth grant. Refresh tokens rotate, so every refresh rewrites
-- qbo_refresh_token. Admin-only, never returned to the client.

ALTER TABLE organization ADD COLUMN IF NOT EXISTS qbo_realm_id VARCHAR(50);
ALTER TABLE organization ADD COLUMN IF NOT EXISTS qbo_refresh_token TEXT;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS qbo_access_token TEXT;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS qbo_access_token_expires_at TIMESTAMPTZ;
ALTER TABLE organization ADD COLUMN IF NOT EXISTS qbo_connected_at TIMESTAMPTZ;
