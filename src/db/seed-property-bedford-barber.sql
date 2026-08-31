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
  'Bedford Barber Co, 20C Miller Rd, Bedford MK42 9NZ. Phone 07429 153 339. '
  'Men''s barbershop, est. 2017, owner Omar. '
  'Hours: Mon 10am-8pm, Tue closed, Wed-Fri 10am-8pm, Sat 9am-6pm, Sun 11:30am-4pm. '
  'Prices: Haircut £20, Skin Fade £25, Haircut + Beard £25, Skin Fade + Beard £30, '
  'Beard Trim £8, Wet Shave + Foam Steam £15, Kids Haircut (under 12) £15, '
  'Kids Skin Fade (under 12) £20, Senior Citizens £10. '
  'Individual appointments: check availability and offer open times; ask the guest '
  'to reply to confirm a slot, and Omar will book it in. '
  'Group bookings (4 or more) are arranged by phone or by replying to this email; '
  'do not confirm a group time yourself -- say Omar will confirm. '
  'Tone: friendly, short, no exclamation marks. Sign off as Omar.'
WHERE NOT EXISTS (SELECT 1 FROM property WHERE name = 'Bedford Barber Co');
