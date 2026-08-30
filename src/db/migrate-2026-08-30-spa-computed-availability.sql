-- One-time migration: computed availability for spa, on top of the
-- existing slot-based flow. See
-- docs/superpowers/specs/2026-08-30-spa-barbershop-bookings-design.md.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline). Idempotent via IF NOT EXISTS and the IS NULL
-- guard on the backfill. Non-destructive: spa_slot, the legacy slot routes,
-- and Pirates Bight's real slots/appointments are all left intact.

-- 1. New tables: per-therapist weekly hours and whole-day time off.
CREATE TABLE IF NOT EXISTS spa_therapist_hours (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  therapist_id UUID NOT NULL REFERENCES spa_therapist(id),
  day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7), -- ISO: 1 = Mon
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_hours_property  ON spa_therapist_hours(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_hours_therapist ON spa_therapist_hours(therapist_id, day_of_week);

CREATE TABLE IF NOT EXISTS spa_therapist_time_off (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  UUID NOT NULL REFERENCES property(id),
  therapist_id UUID NOT NULL REFERENCES spa_therapist(id),
  start_date   DATE NOT NULL,
  end_date     DATE NOT NULL,
  reason       VARCHAR(100),
  CHECK (start_date <= end_date)
);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_time_off_therapist ON spa_therapist_time_off(therapist_id, start_date, end_date);

-- 2. spa: interval + contact details for computed availability and emails.
ALTER TABLE spa ADD COLUMN IF NOT EXISTS slot_interval_minutes INT NOT NULL DEFAULT 15;
ALTER TABLE spa ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
ALTER TABLE spa ADD COLUMN IF NOT EXISTS address TEXT;

-- 3. spa_appointment: record what was actually booked directly on the row,
--    so reads never depend on a slot. Added nullable first (real data
--    exists), backfilled from spa_slot below, then made NOT NULL.
ALTER TABLE spa_appointment ALTER COLUMN slot_id DROP NOT NULL;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS treatment_id     UUID REFERENCES spa_treatment(id);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS therapist_id     UUID REFERENCES spa_therapist(id);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS appointment_date DATE;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS start_time       TIME;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS end_time         TIME;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS confirmation_resend_email_id TEXT;

-- 4. Backfill every existing (slot-based) appointment's direct columns from
--    its slot. Idempotent via the treatment_id IS NULL guard.
UPDATE spa_appointment sa SET
  treatment_id     = ss.treatment_id,
  therapist_id     = ss.therapist_id,
  appointment_date = ss.slot_date,
  start_time       = ss.slot_time,
  end_time         = ss.slot_time + (tr.duration_mins || ' minutes')::interval
FROM spa_slot ss
JOIN spa_treatment tr ON tr.id = ss.treatment_id
WHERE ss.id = sa.slot_id AND sa.treatment_id IS NULL;

-- 5. Now safe to require on every row (backfilled above; new rows always
--    set these directly, slot-based or not).
ALTER TABLE spa_appointment ALTER COLUMN treatment_id     SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN therapist_id     SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN appointment_date SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN start_time       SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN end_time         SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spa_appointment_therapist_date ON spa_appointment(therapist_id, appointment_date);
