-- One-time migration: which sidebar modules/dashboard sections a property
-- actually uses. NULL (the default) means every module is enabled -- an
-- existing property that never visits the new Settings tab sees no change
-- in behavior. Once set, it's the exhaustive array of enabled module keys
-- (see controllers/property.js's MODULE_KEYS) -- a module missing from the
-- array is hidden from the sidebar and the main dashboard.
-- Idempotent via IF NOT EXISTS. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS enabled_modules JSONB;
