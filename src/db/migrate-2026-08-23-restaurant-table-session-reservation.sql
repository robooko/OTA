-- One-time migration: link restaurant_table_session to the reservation that
-- was seated into it, if any (nullable -- most sessions are walk-ins with no
-- reservation). Lets the waitress app show the reservation's contact name
-- and notes on the session, and lets "seating" a reservation open/attach a
-- session at a table that may differ from the one originally booked (a
-- table change) without losing that link.
--
-- No backfill needed: no existing restaurant_table_session row was ever
-- created from a reservation (the "seat" endpoint this column supports is
-- new), so every existing row correctly gets NULL by default.
--
-- Idempotent-safe via IF NOT EXISTS.

ALTER TABLE restaurant_table_session
  ADD COLUMN IF NOT EXISTS reservation_id UUID REFERENCES restaurant_reservation(id);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_session_reservation
  ON restaurant_table_session(reservation_id);
