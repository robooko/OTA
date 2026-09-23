-- Guest-rail salon booking guards -- see src/lib/spaBookingGuard.js.
--
-- contact_email_key: normalised contact_email (lowercased, +tag stripped,
-- Gmail dots removed / googlemail.com folded in) -- what the
-- 3-upcoming-bookings-per-email cap counts on. Set on every insert that has
-- a contact_email, staff bookings included, so they count toward a guest's
-- cap too. The backfill below mirrors emailKey() in spaBookingGuard.js.
--
-- confirm_token_hash / hold_expires_at / pending_email_opts: the
-- email-confirmation hold. A guest booking inserts as status 'pending'
-- (holding the time) until the emailed link is clicked; the sweep cancels
-- holds past hold_expires_at. Only the token's sha256 is stored, since
-- sa.* is returned to the same API key that made the booking.
-- pending_email_opts keeps the request's {branding, cancel_url} just long
-- enough to send the normal confirmation email at confirm time (cleared
-- then) -- the confirm click is a separate request that no longer has them.
--
-- 'pending' is a new spa_appointment.status value. Nothing constrains
-- status with a CHECK, so no constraint change is needed.
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS contact_email_key  VARCHAR(255);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS confirm_token_hash TEXT;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS hold_expires_at    TIMESTAMPTZ;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS pending_email_opts JSONB;

UPDATE spa_appointment SET contact_email_key = (
  SELECT CASE WHEN d IN ('gmail.com', 'googlemail.com')
              THEN replace(l, '.', '') || '@gmail.com'
              ELSE l || '@' || d END
  FROM (SELECT split_part(split_part(lower(trim(contact_email)), '@', 1), '+', 1) AS l,
               split_part(lower(trim(contact_email)), '@', 2) AS d) x
)
WHERE contact_email IS NOT NULL AND contact_email <> '' AND contact_email_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_spa_appointment_property_email_key
  ON spa_appointment (property_id, contact_email_key);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_pending_hold
  ON spa_appointment (hold_expires_at) WHERE status = 'pending';
