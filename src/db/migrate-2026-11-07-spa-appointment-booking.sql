-- A spa appointment can sit on a stay's folio, like restaurant_order.booking_id.
-- Set by the spa appointments import (guest's stay covering the date).
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES booking(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_spa_appointment_booking ON spa_appointment(booking_id);
