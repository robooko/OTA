-- One-time migration: lets a property optionally supply its own Vercel
-- Personal Access Token. Unlike the OAuth Integration's installation token
-- (vercel_access_token), a PAT can read Web Analytics -- this is how a
-- property enables analytics without relying on the shared admin
-- VERCEL_TOKEN env var.

ALTER TABLE property ADD COLUMN IF NOT EXISTS vercel_pat TEXT;
