-- Boatyard services booked through the spa module: a treatment can be priced
-- in bands by boat length overall (length_prices, ascending
-- [{ max_length_m, price }], max inclusive), and an appointment records the
-- boat it is for. NULL length_prices = one price, so no spa changes.
ALTER TABLE spa_treatment ADD COLUMN IF NOT EXISTS length_prices JSONB;
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS boat_name VARCHAR(100);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS boat_length_m NUMERIC(6,2);
