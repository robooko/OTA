-- Salon lead time: the minimum notice, in hours, a guest must give when
-- booking online -- "no bookings less than 2 hours out" so a barber isn't
-- surprised by an appointment ten minutes from now.
--
-- NULL = no minimum (bookable up to the current moment, as before), so every
-- existing salon is unchanged. Applies to the guest rail (X-Api-Key) and the
-- AI reply pipeline's check_availability; staff booking from the dashboard
-- are never held to it -- a walk-in or a phone call is exactly when they
-- need to book something soon.
ALTER TABLE spa ADD COLUMN IF NOT EXISTS lead_time_hours INT;
DO $$ BEGIN
  ALTER TABLE spa ADD CONSTRAINT spa_lead_time_hours_valid
    CHECK (lead_time_hours IS NULL OR lead_time_hours BETWEEN 1 AND 720);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
