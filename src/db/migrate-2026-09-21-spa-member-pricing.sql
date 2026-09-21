-- Regulars' rate ("member pricing") for spa treatments -- first used by
-- Proper Barbering, whose Fresha listing charges less to anyone whose last
-- visit was within the past 4 weeks. Eligibility is derived, not a flag:
-- see src/lib/spaMemberRate.js.
--
-- spa_treatment.member_price: the regulars' rate; NULL = no regulars' rate.
-- spa_treatment.member_duration_mins: NULL = same as duration_mins.
-- spa_treatment.price becomes nullable: NULL with a member_price set is a
-- regulars-only service (Proper's "Membership Undercut" has no standard
-- version). The CHECK keeps every treatment bookable at some price.
ALTER TABLE spa_treatment ADD COLUMN IF NOT EXISTS member_price NUMERIC(10,2);
ALTER TABLE spa_treatment ADD COLUMN IF NOT EXISTS member_duration_mins INT;
ALTER TABLE spa_treatment ALTER COLUMN price DROP NOT NULL;
DO $$ BEGIN
  ALTER TABLE spa_treatment ADD CONSTRAINT spa_treatment_has_price
    CHECK (price IS NOT NULL OR member_price IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The price an appointment was booked at, frozen at booking time. Until now
-- every read joined spa_treatment.price live, so editing a price rewrote
-- the history of every past appointment for it -- and with two prices per
-- treatment the join can't know which one applied anyway. Backfilled from
-- the current treatment price, which is the best record there is.
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS price NUMERIC(10,2);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS member_rate BOOLEAN NOT NULL DEFAULT false;
UPDATE spa_appointment sa SET price = tr.price
FROM spa_treatment tr
WHERE tr.id = sa.treatment_id AND sa.price IS NULL;

-- Grants the regulars' rate for appointments dated up to and including this
-- day, regardless of visit history. Set by staff by hand, or by importing a
-- previous booking system's last-visit dates (last visit + 28 days) so
-- existing regulars keep their rate from launch day.
ALTER TABLE guest ADD COLUMN IF NOT EXISTS member_until DATE;

CREATE INDEX IF NOT EXISTS idx_spa_appointment_property_email
  ON spa_appointment (property_id, lower(contact_email));
