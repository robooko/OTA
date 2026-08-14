-- One-time migration: add spa.status, mirroring the active/inactive
-- pattern used by restaurant, room_type, tour, and already present on
-- spa_treatment/spa_therapist/spa_slot. Lets a spa be soft-deactivated
-- via PUT /api/spa/:id instead of a hard delete. Run ONCE directly
-- against an already-populated database (NOT part of the normal reset
-- pipeline). Idempotent-safe via IF NOT EXISTS. Preserves every existing
-- spa row; status defaults to 'active' for them.

ALTER TABLE spa
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
