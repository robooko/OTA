-- One-time migration: add restaurant_reservation.metadata, a JSONB key/value
-- column for loosely-structured extras (e.g. occasion, seating_preference)
-- that don't warrant their own column. Mirrors booking.metadata (see
-- migrate-2026-07-22-booking-metadata.sql). Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).
-- Idempotent-safe via IF NOT EXISTS. Preserves every existing reservation
-- row; metadata defaults to '{}' for them.

ALTER TABLE restaurant_reservation
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
