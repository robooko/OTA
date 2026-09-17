-- One-time migration: backfill the new 'restaurant_reservations' module key
-- (see controllers/property.js's MODULE_KEYS) onto every property that
-- already has an explicit enabled_modules list.
--
-- enabled_modules is exhaustive once set: a key missing from the array is
-- hidden. So without this, adding the key would silently switch table
-- reservations OFF for every property that had ever visited Settings >
-- Modules -- the opposite of what they chose. NULL (never customised) still
-- means "everything enabled" and needs no backfill.
--
-- Only properties with 'restaurants' on get it: one with restaurants
-- already turned off has nowhere to show reservations anyway, and leaving
-- the key out keeps their array honest about what's enabled.
--
-- Idempotent: the WHERE clause skips rows that already carry the key. Run
-- ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline).

UPDATE property
   SET enabled_modules = enabled_modules || '["restaurant_reservations"]'::jsonb
 WHERE enabled_modules IS NOT NULL
   AND enabled_modules @> '["restaurants"]'::jsonb
   AND NOT (enabled_modules @> '["restaurant_reservations"]'::jsonb);
