-- One-time migration: add room_type.features, search tags such as
-- 'ocean_view', 'private_pool', 'fine_dining'. Filter with ?features=a,b on
-- room types, availability search and basket quote (all tags must match).

ALTER TABLE room_type
  ADD COLUMN IF NOT EXISTS features TEXT[] NOT NULL DEFAULT '{}';
