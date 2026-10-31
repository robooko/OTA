-- One-time migration: property_website.competitors, the rival domains a
-- website's competitor report compares against (src/lib/dataForSeo.js).
-- Bare domains, at most 5 (each is a paid lookup); empty = compare the top 3
-- rivals DataForSEO discovers. Stored, not per-request, so the dashboard's
-- refresh button and a scheduled refresh have something to send.
--
-- Idempotent via IF NOT EXISTS. Run ONCE directly against an already-populated
-- database (NOT part of the normal reset pipeline).

ALTER TABLE property_website ADD COLUMN IF NOT EXISTS competitors TEXT[] NOT NULL DEFAULT '{}';
