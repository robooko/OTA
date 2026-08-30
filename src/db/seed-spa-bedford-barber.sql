-- Spa for Bedford Barber Co -- see
-- docs/superpowers/specs/2026-08-30-spa-barbershop-bookings-design.md.
-- Safe to run directly against an already-populated database. Reuses the
-- "Bedford Barber Co" property by name if seed-property-bedford-barber.sql
-- (from the general-inquiries spec) has already created it; creates it here
-- otherwise, so this file also runs standalone. The spa/treatments/
-- therapist/hours inserts themselves are plain additive INSERTs, same
-- convention as seed-spa-pirates-bight.sql -- not guarded against being run
-- twice.
--
-- Treatment durations are assumptions (see the spec) -- confirm against
-- Booksy's real listing and correct via PUT /api/spa/:spa_id/treatments/:id
-- before relying on them for real bookings.
--
-- No spa_therapist_time_off rows and no legacy spa_slot rows -- bookable
-- availability here comes entirely from spa_therapist_hours below, computed
-- at request time by GET /api/spa/:spa_id/availability.

INSERT INTO property (name, status, currency, timezone)
SELECT 'Bedford Barber Co', 'active', 'GBP', 'Europe/London'
WHERE NOT EXISTS (SELECT 1 FROM property WHERE name = 'Bedford Barber Co');

WITH prop AS (
  SELECT id FROM property WHERE name = 'Bedford Barber Co'
), new_spa AS (
  INSERT INTO spa (property_id, name, phone, address, slot_interval_minutes)
  SELECT prop.id, 'Bedford Barber Co', '07429 153 339', '20C Miller Rd, Bedford MK42 9NZ', 15
  FROM prop
  RETURNING id, property_id
), new_treatments AS (
  INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price)
  SELECT new_spa.property_id, new_spa.id, t.name, t.duration_mins, t.price
  FROM new_spa, (VALUES
    ('Haircut',                    30, 20.00),
    ('Skin Fade',                  30, 25.00),
    ('Haircut + Beard',            45, 25.00),
    ('Skin Fade + Beard',          45, 30.00),
    ('Beard Trim',                 15,  8.00),
    ('Wet Shave + Foam Steam',     30, 15.00),
    ('Kids Haircut (under 12)',    30, 15.00),
    ('Kids Skin Fade (under 12)',  30, 20.00),
    ('Senior Citizens',            30, 10.00)
  ) AS t(name, duration_mins, price)
), new_therapist AS (
  INSERT INTO spa_therapist (property_id, spa_id, name)
  SELECT new_spa.property_id, new_spa.id, 'Omar'
  FROM new_spa
  RETURNING id, property_id
)
INSERT INTO spa_therapist_hours (property_id, therapist_id, day_of_week, start_time, end_time)
SELECT new_therapist.property_id, new_therapist.id, h.day_of_week, h.start_time, h.end_time
FROM new_therapist, (VALUES
  (1, '10:00'::time, '20:00'::time), -- Mon
  -- Tue: no row -- closed
  (3, '10:00'::time, '20:00'::time), -- Wed
  (4, '10:00'::time, '20:00'::time), -- Thu
  (5, '10:00'::time, '20:00'::time), -- Fri
  (6, '09:00'::time, '18:00'::time), -- Sat
  (7, '11:30'::time, '16:00'::time)  -- Sun
) AS h(day_of_week, start_time, end_time);
