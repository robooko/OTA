-- One-time migration: tracks whether a property has completed the Vercel
-- Integration install flow. No access token is stored -- installation
-- tokens can't read Web Analytics (confirmed live), so there's nothing
-- useful to do with one; this is connection status only.

ALTER TABLE property ADD COLUMN IF NOT EXISTS vercel_team_id VARCHAR(100);
ALTER TABLE property ADD COLUMN IF NOT EXISTS vercel_connected_at TIMESTAMPTZ;
