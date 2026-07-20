-- One-time migration: introduce service_period, drop restaurant.service_start/service_end.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline, and NOT idempotent - the INSERT...SELECT and DROP
-- COLUMN steps would fail or duplicate data if run twice). Preserves every
-- existing restaurant, table, reservation, guest, and booking row.
-- See docs/superpowers/plans/2026-07-19-restaurant-service-periods-plan.md.

CREATE TABLE IF NOT EXISTS service_period (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurant(id),
  label         VARCHAR(50),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_service_period_restaurant ON service_period(restaurant_id);

INSERT INTO service_period (restaurant_id, start_time, end_time)
SELECT id, service_start, service_end FROM restaurant;

ALTER TABLE restaurant
  DROP COLUMN service_start,
  DROP COLUMN service_end;
