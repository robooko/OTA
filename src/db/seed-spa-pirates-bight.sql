-- Spa for Pirates Bight
-- Run after schema.sql (and the restaurant seed files, for consistent
-- ordering) during a fresh reset - or as a plain additive INSERT directly
-- against an already-populated database.
-- Note: spa has no property_id yet (out of scope for the multi-property
-- Phase 1 plan), and no FK link to the restaurant table - this is a fully
-- independent spa row, themed to match Pirates Bight but not tied to it
-- in the schema, same as every other unscoped restaurant/spa/tours/etc.
-- module.
--
-- No spa_slot rows are seeded here - bookable availability is generated
-- later via POST /api/spa/:spa_id/slots/bulk, the same way restaurant
-- seeds define tables/hours but never seed example reservations.

WITH new_spa AS (
  INSERT INTO spa (name, description, phone)
  VALUES (
    'Pirates Bight Spa',
    'A barefoot spa retreat steps from the dock on Norman Island, BVI - beachfront treatments beneath the palms.',
    '+1-284-443-1310'
  )
  RETURNING id
), new_treatments AS (
  INSERT INTO spa_treatment (spa_id, name, description, duration_mins, price)
  SELECT new_spa.id, t.name, t.description, t.duration_mins, t.price
  FROM new_spa, (VALUES
    ('Island Swedish Massage', 'A relaxing full-body massage with light-to-medium pressure.', 60, 140.00),
    ('Deep Tissue Massage', 'Firm-pressure massage targeting muscle tension.', 60, 155.00),
    ('Ocean Facial', 'A hydrating facial using marine-based products.', 50, 120.00)
  ) AS t(name, description, duration_mins, price)
)
INSERT INTO spa_therapist (spa_id, name)
SELECT new_spa.id, t.name
FROM new_spa, (VALUES
  ('Marisol Fahie'),
  ('Dwayne Christopher')
) AS t(name);
