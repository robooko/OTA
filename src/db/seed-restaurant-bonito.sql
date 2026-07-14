-- Restaurant, tables, and timeslots for Bonito
-- Run after schema.sql (and seed.sql, for consistent ordering with other seed files)
-- Note: the restaurant module has no property_id yet (out of scope for the
-- multi-property Phase 1 plan), so this data is unscoped like the rest of
-- the restaurant/spa/tours/etc. modules.

WITH new_restaurant AS (
  INSERT INTO restaurant (name, description, phone)
  VALUES (
    'Bonito',
    'Bonito''s signature restaurant, serving fresh local produce with seasonal tasting menus.',
    '+1-555-0199'
  )
  RETURNING id
),
new_tables AS (
  INSERT INTO restaurant_table (restaurant_id, table_number, seats, location)
  SELECT new_restaurant.id, t.table_number, t.seats, t.location
  FROM new_restaurant, (VALUES
    ('T1', 2, 'Indoor'),
    ('T2', 2, 'Indoor'),
    ('T3', 4, 'Indoor'),
    ('T4', 4, 'Terrace'),
    ('T5', 6, 'Terrace')
  ) AS t(table_number, seats, location)
  RETURNING restaurant_id
)
INSERT INTO time_slot (restaurant_id, slot_date, slot_time, available_seats)
SELECT nr.id, d::date, tm.slot_time, 18
FROM new_restaurant nr
CROSS JOIN generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '6 days', '1 day') AS d
CROSS JOIN (VALUES ('13:00'::time), ('20:00'::time)) AS tm(slot_time);
