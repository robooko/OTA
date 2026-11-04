-- One-time migration: add room_type.code, an optional short code (max 3
-- characters, e.g. 'DBL'), unique per property when set.

ALTER TABLE room_type
  ADD COLUMN IF NOT EXISTS code VARCHAR(3);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_type_property_code
  ON room_type(property_id, code) WHERE code IS NOT NULL;
