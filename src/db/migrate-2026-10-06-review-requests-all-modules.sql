-- Review requests for every module, one per visit -- see
-- docs/superpowers/specs/2026-10-06-review-requests-all-modules-design.md.
--
-- review_request: one row per request sent (or being retried), whatever
-- module the triggering booking came from. contact_name is copied at
-- claim time so a retry needs nothing else.
-- review_candidate: every eligible module's bookings in one shape, with
-- ended_at as a timestamptz in the property's own timezone. Includes
-- bookings that haven't ended yet -- the claim needs to see a visit
-- that's still in progress.
-- Backfill: spa requests already sent under the old per-appointment
-- columns, so the cooldown keeps counting them. Those columns stay as
-- history; nothing writes them after this.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).

CREATE TABLE IF NOT EXISTS review_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID NOT NULL REFERENCES property(id),
  email            VARCHAR(255) NOT NULL,
  contact_name     VARCHAR(100),
  module           VARCHAR(30)  NOT NULL,
  booking_id       UUID NOT NULL,
  sent_at          TIMESTAMPTZ,
  attempts         SMALLINT NOT NULL DEFAULT 1,
  resend_email_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module, booking_id)
);
CREATE INDEX IF NOT EXISTS idx_review_request_guest ON review_request (property_id, email, created_at);
CREATE INDEX IF NOT EXISTS idx_review_request_retry ON review_request (attempts) WHERE sent_at IS NULL;

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
  WHERE coalesce(b.status, 'confirmed') NOT IN ('cancelled', 'no_show')
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

INSERT INTO review_request (property_id, email, contact_name, module, booking_id, sent_at, attempts, resend_email_id, created_at)
SELECT sa.property_id, lower(trim(sa.contact_email)), sa.contact_name, 'spa', sa.id,
       sa.review_request_sent_at, greatest(sa.review_request_attempts, 1), sa.review_request_resend_email_id, sa.review_request_sent_at
FROM spa_appointment sa
WHERE sa.review_request_sent_at IS NOT NULL AND sa.contact_email IS NOT NULL
ON CONFLICT (module, booking_id) DO NOTHING;
