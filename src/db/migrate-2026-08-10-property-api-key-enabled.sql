-- One-time migration: add property.api_key_enabled, an instant on/off
-- switch for a property's API key independent of rotation (disabling
-- doesn't change the key value; re-enabling restores access with the
-- same key). Checked by authenticateOrApiKey in src/middleware/auth.js.
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS api_key_enabled BOOLEAN NOT NULL DEFAULT true;
