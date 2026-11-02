-- Cash payments for restaurant tabs and spa appointments: how a paid row was
-- settled. Every row paid before this was Stripe (cash couldn't mark paid).
ALTER TABLE restaurant_table_session ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
  CONSTRAINT restaurant_table_session_payment_method CHECK (payment_method IN ('card', 'cash'));
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
  CONSTRAINT spa_appointment_payment_method CHECK (payment_method IN ('card', 'cash'));
UPDATE restaurant_table_session SET payment_method = 'card' WHERE payment_status = 'paid' AND payment_method IS NULL;
UPDATE spa_appointment SET payment_method = 'card' WHERE payment_status = 'paid' AND payment_method IS NULL;
