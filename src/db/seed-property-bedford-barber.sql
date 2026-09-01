-- Property for Bedford Barber Co (a barbershop, not a hotel) -- the first
-- property to use the event-inquiries module for group bookings and general
-- enquiries from its public website. See
-- docs/superpowers/specs/2026-08-30-general-inquiries-design.md.
--
-- Additive and idempotent: safe to run directly against an already-populated
-- database, and running it twice leaves one property.
--
-- api_key is deliberately NULL. Mint it with POST /api/property/api-key/rotate
-- once a Clerk org is linked, or set it directly in SQL; then store it as
-- OTA_API_KEY in the site's Vercel env. Never commit the key.
--
-- ai_reply_mode starts at 'draft' so every Claude draft needs Omar's approval;
-- flip to 'auto' via PUT /api/property/ai-replies after reviewing a few.
-- ai_reply_instructions is the ONLY set of facts the model may state.

INSERT INTO property (name, status, currency, timezone, ai_reply_mode, ai_reply_instructions)
SELECT
  'Bedford Barber Co',
  'active',
  'GBP',
  'Europe/London',
  'draft',
  -- Policy and tone only: address, phone, services, prices and hours are
  -- injected into the prompt from the spa's own DB records (see OTA's
  -- aiReplyPipeline loadSpaContext), so they are never duplicated here.
  E'Bedford Barber Co -- men''s barbershop, est. 2017, owned by Omar.\n'
  'Only mention prices the guest asked about.\n'
  'Individual appointments: check live availability and offer open times.\n'
  'Group bookings (4 or more): arranged by phone or by replying to this email. '
  'Never confirm a group time; say Omar will confirm.\n'
  'Style: friendly and short, no exclamation marks. Sign off as Omar.'
WHERE NOT EXISTS (SELECT 1 FROM property WHERE name = 'Bedford Barber Co');
