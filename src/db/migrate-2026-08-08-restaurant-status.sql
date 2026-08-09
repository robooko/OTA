-- One-time migration: add restaurant.status, mirroring restaurant_table.status
-- (and the active/inactive pattern used by golf_course, tour, equipment,
-- proshop_item, room_service_item, spa_treatment, spa_therapist, extra).
-- Lets a restaurant be soft-deactivated via PUT /api/restaurant/:id instead
-- of a hard delete. Run ONCE directly against an already-populated database
-- (NOT part of the normal reset pipeline). Idempotent-safe via IF NOT
-- EXISTS. Preserves every existing restaurant row; status defaults to
-- 'active' for them.

ALTER TABLE restaurant
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';
