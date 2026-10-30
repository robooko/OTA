-- Room rate plans (Saver/Flex) and card payment for room bookings -- see
-- docs/superpowers/specs/2026-10-30-room-rate-plans-design.md.

CREATE TABLE IF NOT EXISTS rate_plan (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id         UUID          NOT NULL REFERENCES property(id),
  room_type_id        UUID          NOT NULL REFERENCES room_type(id),
  name                VARCHAR(100)  NOT NULL,           -- 'Saver', 'Flex'
  adjustment_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0, -- -12.00 = 12% off
  refundable          BOOLEAN       NOT NULL,
  cancel_cutoff_hours INT,                              -- hours before check-in day's local midnight
  payment_mode        VARCHAR(10)   NOT NULL,           -- 'full' | 'deposit' | 'hold'
  deposit_kind        VARCHAR(10),                      -- 'percent' | 'fixed'
  deposit_value       NUMERIC(10,2),
  sort_order          INT           NOT NULL DEFAULT 0,
  status              VARCHAR(20)   NOT NULL DEFAULT 'active', -- 'active' | 'archived'
  CONSTRAINT rate_plan_payment_mode_check CHECK (payment_mode IN ('full', 'deposit', 'hold')),
  CONSTRAINT rate_plan_status_check CHECK (status IN ('active', 'archived')),
  CONSTRAINT rate_plan_cutoff_check CHECK (refundable = (cancel_cutoff_hours IS NOT NULL) AND (cancel_cutoff_hours IS NULL OR cancel_cutoff_hours >= 0)),
  CONSTRAINT rate_plan_deposit_check CHECK ((payment_mode = 'deposit') = (deposit_kind IS NOT NULL AND deposit_value IS NOT NULL)),
  CONSTRAINT rate_plan_deposit_kind_check CHECK (deposit_kind IS NULL OR deposit_kind IN ('percent', 'fixed')),
  CONSTRAINT rate_plan_hold_refundable_check CHECK (NOT (payment_mode = 'hold' AND NOT refundable)),
  CONSTRAINT rate_plan_adjustment_check CHECK (adjustment_pct >= -100)
);
CREATE INDEX IF NOT EXISTS idx_rate_plan_room_type ON rate_plan(room_type_id);

ALTER TABLE booking ADD COLUMN IF NOT EXISTS rate_plan_id             UUID REFERENCES rate_plan(id);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS rate_plan_terms          JSONB;        -- plan snapshot at booking time
ALTER TABLE booking ADD COLUMN IF NOT EXISTS payment_due_at           TIMESTAMPTZ;  -- set while pending_payment
ALTER TABLE booking ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255); -- the booking's card PI
CREATE INDEX IF NOT EXISTS idx_booking_pending_due ON booking(payment_due_at) WHERE status = 'pending_payment';

-- An expired (never paid) booking no longer holds the room.
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_no_overlap;
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out) WITH &&) WHERE (status NOT IN ('cancelled', 'expired'));

ALTER TABLE property ADD COLUMN IF NOT EXISTS room_booking_url TEXT; -- may contain {id} (room booking id)

CREATE OR REPLACE VIEW review_candidate AS
SELECT * FROM (
  -- rooms: departure counted as 11:00 local on the check-out date
  SELECT b.property_id, lower(trim(g.email))::varchar(255) AS email, g.first_name::varchar(100) AS contact_name,
         'rooms'::varchar(30) AS module, b.id AS booking_id,
         (b.check_out + time '11:00') AT TIME ZONE p.timezone AS ended_at,
         -- a stay "starts" at 15:00 local on check-in; anything of theirs
         -- before then is the same visit
         (b.check_in + time '15:00') AT TIME ZONE p.timezone AS started_at
  FROM booking b JOIN guest g ON g.id = b.guest_id JOIN property p ON p.id = b.property_id
  WHERE coalesce(b.status, 'confirmed') NOT IN ('cancelled', 'no_show', 'expired', 'pending_payment')
  UNION ALL
  SELECT r.property_id, lower(trim(r.contact_email)), r.contact_name, 'restaurant_reservations', r.id,
         (r.reservation_date + r.end_time) AT TIME ZONE p.timezone, NULL::timestamptz
  FROM restaurant_reservation r JOIN property p ON p.id = r.property_id
  WHERE coalesce(r.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  SELECT o.property_id, lower(trim(o.contact_email)), o.contact_name, 'restaurants', o.id, o.paid_at, NULL::timestamptz
  FROM restaurant_order o
  WHERE o.payment_status = 'paid' AND o.paid_at IS NOT NULL
  UNION ALL
  SELECT s.property_id, lower(trim(s.contact_email)), s.contact_name, 'spa', s.id,
         (s.appointment_date + s.end_time) AT TIME ZONE p.timezone, NULL::timestamptz
  FROM spa_appointment s JOIN property p ON p.id = s.property_id
  WHERE coalesce(s.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  -- tours: the tour's own duration after the slot starts
  SELECT tb.property_id, lower(trim(coalesce(tb.contact_email, g.email))), tb.contact_name, 'tours', tb.id,
         (ts.slot_date + ts.slot_time + make_interval(mins => t.duration_mins)) AT TIME ZONE p.timezone, NULL::timestamptz
  FROM tour_booking tb
  JOIN tour_slot ts ON ts.id = tb.slot_id JOIN tour t ON t.id = ts.tour_id
  JOIN property p ON p.id = tb.property_id LEFT JOIN guest g ON g.id = tb.guest_id
  WHERE coalesce(tb.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  -- golf: a round counted as 4 hours from the tee time
  SELECT gb.property_id, lower(trim(coalesce(gb.contact_email, g.email))), gb.contact_name, 'golf', gb.id,
         (tt.tee_date + tt.tee_time + interval '4 hours') AT TIME ZONE p.timezone, NULL::timestamptz
  FROM golf_booking gb
  JOIN tee_time tt ON tt.id = gb.tee_time_id
  JOIN property p ON p.id = gb.property_id LEFT JOIN guest g ON g.id = gb.guest_id
  WHERE coalesce(gb.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  -- equipment: start + duration hours; a hire with no start time ends at the end of its day
  SELECT e.property_id, lower(trim(coalesce(e.contact_email, g.email))), e.contact_name, 'equipment', e.id,
         (CASE WHEN e.start_time IS NULL THEN e.hire_date + time '00:00' + interval '24 hours'
               ELSE e.hire_date + e.start_time + make_interval(secs => coalesce(e.duration, 1) * 3600) END) AT TIME ZONE p.timezone, NULL::timestamptz
  FROM equipment_hire e
  JOIN property p ON p.id = e.property_id LEFT JOIN guest g ON g.id = e.guest_id
  WHERE coalesce(e.status, 'confirmed') NOT IN ('cancelled', 'no_show')
) u
WHERE email IS NOT NULL AND email <> '';
