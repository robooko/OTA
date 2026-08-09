-- Restaurant and tables for Pirates Bight
-- Run after schema.sql and the other restaurant seed files during a fresh
-- reset - or as a plain additive INSERT directly against an
-- already-populated database.
--
-- Pirates Bight is a Caribbean dockside kitchen and rum bar, open daily
-- 11am-9pm (single continuous service window, no lunch/dinner gap), with
-- dinghy access direct to the restaurant dock. Closed seasonally Aug 1 -
-- Sep 30 (open October through July).

WITH new_restaurant AS (
  INSERT INTO restaurant (property_id, name, description, phone, slot_interval_minutes, default_duration_minutes)
  VALUES (
    'e1000000-0000-0000-0000-000000000004',
    'Pirates Bight',
    'A Caribbean dockside kitchen and rum bar on Norman Island, BVI - island cooking and a legendary rum selection, with dinghy access direct to the restaurant dock.',
    '+1-284-443-1305',
    15, 75
  )
  RETURNING id
), new_tables AS (
  INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats, location)
  SELECT 'e1000000-0000-0000-0000-000000000004', new_restaurant.id, t.table_number, t.seats, t.location
  FROM new_restaurant, (VALUES
    ('T1', 2, 'Dock'),
    ('T2', 2, 'Dock'),
    ('T3', 4, 'Deck'),
    ('T4', 4, 'Deck'),
    ('T5', 6, 'Indoor')
  ) AS t(table_number, seats, location)
), new_period AS (
  INSERT INTO service_period (property_id, restaurant_id, start_time, end_time)
  SELECT 'e1000000-0000-0000-0000-000000000004', new_restaurant.id, '11:00', '21:00'
  FROM new_restaurant
)
INSERT INTO restaurant_seasonal_closure (property_id, restaurant_id, start_month, start_day, end_month, end_day)
SELECT 'e1000000-0000-0000-0000-000000000004', new_restaurant.id, 8, 1, 9, 30
FROM new_restaurant;
