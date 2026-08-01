-- One-time migration: add spa_appointment.clerk_user_id, mirroring
-- restaurant_reservation.clerk_user_id (see migrate-2026-07-16 equivalent
-- change, folded into schema.sql before the migration-file convention
-- started). Lets a spa appointment be linked to a Clerk-authenticated
-- customer for lookup/filtering. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).
-- Idempotent-safe via IF NOT EXISTS. Preserves every existing appointment
-- row; clerk_user_id defaults to NULL for them.

ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS clerk_user_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_spa_appointment_clerk_user ON spa_appointment(clerk_user_id);
