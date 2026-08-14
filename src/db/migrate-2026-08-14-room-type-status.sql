-- One-time migration: add room_type.status, mirroring the active/inactive
-- pattern used by restaurant, room, golf_course, tour, equipment,
-- proshop_item, room_service_item, spa_treatment, spa_therapist, extra.
-- Lets a room type be soft-deactivated via PUT /api/room-types/:id instead
-- of a hard delete. Run ONCE directly against an already-populated database
-- (NOT part of the normal reset pipeline). Idempotent-safe via IF NOT
-- EXISTS. Preserves every existing room_type row; status defaults to
-- 'active' for them.

ALTER TABLE room_type
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
