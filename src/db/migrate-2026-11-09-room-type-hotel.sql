-- One-time migration: add room_type.hotel, an optional label grouping room
-- types into hotels inside one property (e.g. Hamilton Island: 'qualia',
-- 'Reef View Hotel'). Shared settings, one checkout. Split into separate
-- properties under the org only when a hotel needs its own settings.

ALTER TABLE room_type
  ADD COLUMN IF NOT EXISTS hotel VARCHAR(100);
