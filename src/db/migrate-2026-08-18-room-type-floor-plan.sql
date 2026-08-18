-- One-time migration: add room_type.floor_plan, a JSONB blob holding the
-- staff-built visual room layout ({ rooms: [...], items: [...], w, h }).
-- Same pattern as migrate-2026-08-18-restaurant-floor-plan.sql. Preserves
-- every existing row; floor_plan defaults to '{}' for them.

ALTER TABLE room_type
  ADD COLUMN IF NOT EXISTS floor_plan JSONB NOT NULL DEFAULT '{}';
