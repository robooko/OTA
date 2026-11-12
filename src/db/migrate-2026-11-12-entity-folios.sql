-- Charges on every booking: payment and folio_adjustment can belong to a golf
-- booking, equipment hire, restaurant reservation or spa appointment, not
-- only a room booking. Exactly one owner per row. Existing rows keep booking_id.
BEGIN;
ALTER TABLE payment ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS golf_booking_id           UUID REFERENCES golf_booking(id),
  ADD COLUMN IF NOT EXISTS equipment_hire_id         UUID REFERENCES equipment_hire(id),
  ADD COLUMN IF NOT EXISTS restaurant_reservation_id UUID REFERENCES restaurant_reservation(id),
  ADD COLUMN IF NOT EXISTS spa_appointment_id        UUID REFERENCES spa_appointment(id);
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_one_owner;
ALTER TABLE payment ADD CONSTRAINT payment_one_owner CHECK
  (num_nonnulls(booking_id, golf_booking_id, equipment_hire_id, restaurant_reservation_id, spa_appointment_id) = 1);

ALTER TABLE folio_adjustment ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE folio_adjustment
  ADD COLUMN IF NOT EXISTS golf_booking_id           UUID REFERENCES golf_booking(id),
  ADD COLUMN IF NOT EXISTS equipment_hire_id         UUID REFERENCES equipment_hire(id),
  ADD COLUMN IF NOT EXISTS restaurant_reservation_id UUID REFERENCES restaurant_reservation(id),
  ADD COLUMN IF NOT EXISTS spa_appointment_id        UUID REFERENCES spa_appointment(id);
ALTER TABLE folio_adjustment DROP CONSTRAINT IF EXISTS folio_adjustment_one_owner;
ALTER TABLE folio_adjustment ADD CONSTRAINT folio_adjustment_one_owner CHECK
  (num_nonnulls(booking_id, golf_booking_id, equipment_hire_id, restaurant_reservation_id, spa_appointment_id) = 1);

CREATE INDEX IF NOT EXISTS idx_payment_golf_booking_id           ON payment(golf_booking_id)           WHERE golf_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_equipment_hire_id         ON payment(equipment_hire_id)         WHERE equipment_hire_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_restaurant_reservation_id ON payment(restaurant_reservation_id) WHERE restaurant_reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_spa_appointment_id        ON payment(spa_appointment_id)        WHERE spa_appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folio_adjustment_golf_booking_id           ON folio_adjustment(golf_booking_id)           WHERE golf_booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folio_adjustment_equipment_hire_id         ON folio_adjustment(equipment_hire_id)         WHERE equipment_hire_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folio_adjustment_restaurant_reservation_id ON folio_adjustment(restaurant_reservation_id) WHERE restaurant_reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folio_adjustment_spa_appointment_id        ON folio_adjustment(spa_appointment_id)        WHERE spa_appointment_id IS NOT NULL;
COMMIT;
