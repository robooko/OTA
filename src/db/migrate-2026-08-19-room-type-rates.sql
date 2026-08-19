-- One-time migration: adds room_type_rate, a per-date nightly rate layer for
-- room types (channel-manager style daily rows; the API accepts date ranges
-- and fans them out server-side), and rebuilds the room_type_availability
-- materialized view so min_rate resolves
-- COALESCE(override_rate, room_type_rate.rate, base_rate) -- the per-room
-- override stays the most specific exception and still wins; a dated type
-- rate beats the static base_rate.
--
-- The view must be DROPped and recreated because schema.sql's
-- CREATE MATERIALIZED VIEW IF NOT EXISTS never updates an existing view;
-- the unique index is recreated in the same batch so every
-- REFRESH ... CONCURRENTLY call site keeps working.
--
-- Preserves every existing row: room_type_rate starts empty, so every
-- min_rate value is unchanged until staff enter dated rates.

CREATE TABLE IF NOT EXISTS room_type_rate (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID          NOT NULL REFERENCES property(id),
  room_type_id  UUID          NOT NULL REFERENCES room_type(id),
  date          DATE          NOT NULL,
  rate          NUMERIC(10,2) NOT NULL,
  UNIQUE (room_type_id, date)
);

CREATE INDEX IF NOT EXISTS idx_room_type_rate_property ON room_type_rate(property_id);

DROP MATERIALIZED VIEW IF EXISTS room_type_availability;

CREATE MATERIALIZED VIEW room_type_availability AS
SELECT
  r.property_id,
  r.room_type_id,
  ra.date,
  COUNT(*)                                                AS total_rooms,
  COUNT(*) FILTER (WHERE ra.is_available = true)          AS available_rooms,
  MIN(COALESCE(ra.override_rate, rtr.rate, rt.base_rate)) AS min_rate
FROM room_availability ra
JOIN room      r  ON r.id  = ra.room_id
JOIN room_type rt ON rt.id = r.room_type_id
LEFT JOIN room_type_rate rtr
       ON rtr.room_type_id = r.room_type_id
      AND rtr.date         = ra.date
GROUP BY r.property_id, r.room_type_id, ra.date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rta_property_type_date ON room_type_availability(property_id, room_type_id, date);
