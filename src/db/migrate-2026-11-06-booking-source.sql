-- How a direct room booking came in. Null = not recorded (older bookings,
-- channel bookings: channel_id says where those came from).
ALTER TABLE booking ADD COLUMN IF NOT EXISTS source VARCHAR(10)
  CHECK (source IN ('web', 'phone', 'email', 'walk_in', 'agent'));
