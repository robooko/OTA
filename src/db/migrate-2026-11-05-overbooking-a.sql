-- Room overbooking, part A (additive; run on live BEFORE pushing the code).
-- See docs/superpowers/specs/2026-11-05-room-overbooking-design.md.
-- Old code keeps working on this schema: it still writes booking.room_id and
-- the room_availability flags; part B (after deploy) backfills what it wrote
-- in between and tightens the constraints.

-- The room type a booking was sold as; its room(s) may differ after a move.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS room_type_id UUID REFERENCES room_type(id);
-- Old code (still serving until the deploy) inserts bookings without a sold
-- type: take it from the room. New code always sets it, so this is a no-op
-- for it; kept afterwards as a harmless default.
CREATE OR REPLACE FUNCTION booking_default_room_type() RETURNS trigger AS $
BEGIN
  IF NEW.room_type_id IS NULL AND NEW.room_id IS NOT NULL THEN
    NEW.room_type_id := (SELECT room_type_id FROM room WHERE id = NEW.room_id);
  END IF;
  RETURN NEW;
END $ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS booking_default_room_type ON booking;
CREATE TRIGGER booking_default_room_type BEFORE INSERT ON booking
  FOR EACH ROW EXECUTE FUNCTION booking_default_room_type();
-- true = the guest/staff named the room; it can never be bumped.
ALTER TABLE booking ADD COLUMN IF NOT EXISTS room_pick BOOLEAN NOT NULL DEFAULT false;
-- room_id is now "current room": null while no room is held tonight / yet.
ALTER TABLE booking ALTER COLUMN room_id DROP NOT NULL;

-- Occupancy: one row per night a booking holds (room_id null = no room yet).
-- Rows exist only while the booking holds the night (pending_payment,
-- confirmed, checked_in; checked_out keeps its past nights).
CREATE TABLE IF NOT EXISTS booking_night (
  booking_id  UUID NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES property(id),
  night       DATE NOT NULL,
  room_id     UUID REFERENCES room(id),
  PRIMARY KEY (booking_id, night)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_night_room ON booking_night(room_id, night) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_booking_night_property_night ON booking_night(property_id, night);

-- Every room a booking was put in, taken out of or moved between.
CREATE TABLE IF NOT EXISTS booking_room_move (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  booking_id   UUID NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  night_from   DATE NOT NULL,
  night_to     DATE NOT NULL,
  from_room_id UUID REFERENCES room(id),
  to_room_id   UUID REFERENCES room(id),
  reason       VARCHAR(10) NOT NULL CHECK (reason IN ('assign', 'bump', 'upgrade', 'downgrade', 'move', 'release')),
  moved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  moved_by     VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_booking_room_move_booking ON booking_room_move(booking_id, moved_at);

-- Oversell allowance per room type and night: the model's, and a manager's
-- override (null = follow the model).
CREATE TABLE IF NOT EXISTS room_type_oversell (
  property_id      UUID NOT NULL REFERENCES property(id),
  room_type_id     UUID NOT NULL REFERENCES room_type(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  model_allowance  INT  NOT NULL DEFAULT 0 CHECK (model_allowance >= 0),
  manual_allowance INT  CHECK (manual_allowance >= 0),
  model            VARCHAR(100),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_type_id, date)
);
CREATE INDEX IF NOT EXISTS idx_room_type_oversell_property_date ON room_type_oversell(property_id, date);

-- Per-property switch, cap (% of a type's active rooms) and pick cutoff (days
-- before arrival from which an auto-assigned room can no longer be bumped).
ALTER TABLE property ADD COLUMN IF NOT EXISTS overbooking_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE property ADD COLUMN IF NOT EXISTS oversell_max_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (oversell_max_pct >= 0 AND oversell_max_pct <= 100);
ALTER TABLE property ADD COLUMN IF NOT EXISTS room_lock_days INT NOT NULL DEFAULT 1 CHECK (room_lock_days >= 0 AND room_lock_days <= 30);

-- Backfill (part B repeats these two statements verbatim).
UPDATE booking b SET room_type_id = r.room_type_id FROM room r WHERE r.id = b.room_id AND b.room_type_id IS NULL;
INSERT INTO booking_night (booking_id, property_id, night, room_id)
SELECT b.id, b.property_id, n::date, b.room_id
FROM booking b, generate_series(b.check_in, b.check_out - 1, interval '1 day') n
WHERE b.status IN ('pending_payment', 'confirmed', 'checked_in')
   OR (b.status = 'checked_out' AND n::date < CURRENT_DATE)
ON CONFLICT DO NOTHING;

-- room_type_availability per type x date over ACTIVE rooms (dates come from
-- room_availability, seeded ahead for every active room).
--   available_rooms = rooms neither held by a booking nor staff-blocked
--   sold            = nights taken from the type: held in its rooms (any guest)
--                     plus nights of bookings sold as it with no room yet
--   sellable_rooms  = rooms - blocked - sold + oversell allowance (>= 0)
-- A closed flag with a booking_night on it is a booking, not a block.
DROP MATERIALIZED VIEW IF EXISTS room_type_availability;
CREATE MATERIALIZED VIEW room_type_availability AS
WITH grid AS (
  SELECT r.property_id, r.room_type_id, ra.date,
         COUNT(*) AS total_rooms,
         COUNT(*) FILTER (WHERE ra.is_available AND h.room_id IS NULL)     AS available_rooms,
         COUNT(*) FILTER (WHERE NOT ra.is_available AND h.room_id IS NULL) AS blocked_rooms,
         MIN(COALESCE(ra.override_rate, rtr.rate, rt.base_rate))           AS min_rate
  FROM room_availability ra
  JOIN room      r  ON r.id  = ra.room_id AND r.status = 'active'
  JOIN room_type rt ON rt.id = r.room_type_id
  LEFT JOIN booking_night h ON h.room_id = ra.room_id AND h.night = ra.date
  LEFT JOIN room_type_rate rtr ON rtr.room_type_id = r.room_type_id AND rtr.date = ra.date
  GROUP BY r.property_id, r.room_type_id, ra.date
),
sold AS (
  SELECT COALESCE(hr.room_type_id, b.room_type_id) AS room_type_id, bn.night, COUNT(*) AS n
  FROM booking_night bn JOIN booking b ON b.id = bn.booking_id
  LEFT JOIN room hr ON hr.id = bn.room_id
  GROUP BY 1, bn.night
),
alw AS (
  SELECT g.room_type_id, g.date,
         CASE WHEN p.overbooking_enabled
              THEN LEAST(COALESCE(o.manual_allowance, o.model_allowance, 0), floor(p.oversell_max_pct / 100 * g.total_rooms))::int
              ELSE 0 END AS allowance
  FROM grid g
  JOIN property p ON p.id = g.property_id
  LEFT JOIN room_type_oversell o ON o.room_type_id = g.room_type_id AND o.date = g.date
)
SELECT g.property_id, g.room_type_id, g.date, g.total_rooms, g.available_rooms, g.min_rate,
       COALESCE(s.n, 0)                                                              AS sold,
       a.allowance                                                                   AS oversell_allowance,
       GREATEST(0, g.total_rooms - g.blocked_rooms - COALESCE(s.n, 0) + a.allowance) AS sellable_rooms
FROM grid g
JOIN alw a ON a.room_type_id = g.room_type_id AND a.date = g.date
LEFT JOIN sold s ON s.room_type_id = g.room_type_id AND s.night = g.date;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rta_property_type_date ON room_type_availability(property_id, room_type_id, date);
