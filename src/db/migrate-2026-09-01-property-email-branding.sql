-- Property-level email branding (Settings -> Branding in the dashboard).
-- Until now branding only ever arrived per-request from a website (spa
-- appointment create/cancel, and event_inquiry.branding for AI-made
-- bookings), so bookings made from the dashboard itself went out plain.
-- The spa email path now falls back to these when a request supplies none,
-- making per-request branding an override rather than the mechanism.
--
-- email_branding is {logo_url, brand_color, header_bg} (same shape and
-- validation as the per-request object); email_cancel_url may contain {id},
-- replaced with the appointment id when the confirmation is sent.
--
-- Idempotent via IF NOT EXISTS.

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS email_branding   JSONB,
  ADD COLUMN IF NOT EXISTS email_cancel_url TEXT;
