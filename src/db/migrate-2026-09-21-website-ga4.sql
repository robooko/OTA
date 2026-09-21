-- One-time migration: property_website.ga4_property_id, the Google Analytics
-- alternative to vercel_project_id for the dashboard's visitors chart.
--
-- Numeric GA4 property id (the "Property ID" in GA Admin > Property details,
-- not the G- measurement id). NULL = not mapped. Read with Forge's single
-- service account (GA_SERVICE_ACCOUNT_JSON), which each venue adds as a
-- Viewer on their property -- see src/lib/googleAnalytics.js.
--
-- A website maps to one source at a time: when ga4_property_id is set it wins
-- over vercel_project_id, and the Settings UI clears the other on save.
--
-- Idempotent via IF NOT EXISTS. Run ONCE directly against an already-populated
-- database (NOT part of the normal reset pipeline).

ALTER TABLE property_website ADD COLUMN IF NOT EXISTS ga4_property_id VARCHAR(20);
