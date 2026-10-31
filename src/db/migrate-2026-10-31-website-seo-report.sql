-- One-time migration: website_seo_report, every competitor report fetched for
-- a website from DataForSEO (src/lib/dataForSeo.js). Append-only -- each
-- refresh is a paid lookup, and the history is what shows competitors moving
-- over time. The latest report is the newest row.
--
-- Idempotent via IF NOT EXISTS. Run ONCE directly against an already-populated
-- database (NOT part of the normal reset pipeline).

CREATE TABLE IF NOT EXISTS website_seo_report (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id  UUID        NOT NULL REFERENCES property_website(id),
  report      JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS website_seo_report_website_created_idx
  ON website_seo_report (website_id, created_at DESC);
