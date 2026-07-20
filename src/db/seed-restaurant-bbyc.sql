-- Restaurant and tables for BBYC (Bora Bora Yacht Club)
-- Run after schema.sql and the other restaurant seed files during a fresh
-- reset - or as a plain additive INSERT directly against an
-- already-populated database (this is how it was actually rolled out; see
-- docs/superpowers/plans/2026-07-19-restaurant-service-periods-plan.md).
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.
--
-- BBYC is open daily (no closed_days) with two separate service windows -
-- lunch and dinner - hence two service_period rows instead of one.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'BBYC',
    'Bora Bora Yacht Club - a waterfront clubhouse serving lunch and dinner daily.',
    '+1-555-0204',
    15, 90
  )
  RETURNING id
), new_tables AS (
  INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
  SELECT new_restaurant.id, t.table_number, t.seats, t.location
  FROM new_restaurant, (VALUES
    ('T1', 2, 'Marina'),
    ('T2', 2, 'Marina'),
    ('T3', 4, 'Indoor'),
    ('T4', 4, 'Indoor'),
    ('T5', 6, 'Terrace')
  ) AS t(table_number, seats, location)
)
INSERT INTO service_period (restaurant_id, label, start_time, end_time)
SELECT new_restaurant.id, sp.label, sp.start_time, sp.end_time
FROM new_restaurant, (VALUES
  ('Lunch', '11:30'::time, '14:30'::time),
  ('Dinner', '17:30'::time, '21:30'::time)
) AS sp(label, start_time, end_time);
