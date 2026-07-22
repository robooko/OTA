-- One-time migration: add booking.metadata, a JSONB key/value column for
-- loosely-structured extras (e.g. pickup_location) that don't warrant their
-- own column. Run ONCE directly against an already-populated database (NOT
-- part of the normal reset pipeline). Idempotent-safe via IF NOT EXISTS.
-- Preserves every existing booking row; metadata defaults to '{}' for them.

ALTER TABLE booking
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
