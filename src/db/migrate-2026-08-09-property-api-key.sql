-- One-time migration: add property.api_key, a per-property secret used by
-- authenticateOrApiKey (src/middleware/auth.js) to replace the single
-- shared API_KEY env var. Idempotent-safe via IF NOT EXISTS. Backfills
-- every existing property with a random key so nothing is left without
-- one before the middleware cutover in a later step. Run ONCE directly
-- against an already-populated database (NOT part of the normal reset
-- pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS api_key TEXT UNIQUE;
UPDATE property SET api_key = 'prop_' || encode(gen_random_bytes(32), 'hex') WHERE api_key IS NULL;
