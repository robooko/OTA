-- One-time migration: add event_inquiry.branding and event_inquiry.cancel_url
-- so a spa booking made from an AI reply (aiReplyPipeline bookProposedSlot)
-- can send the same branded confirmation email as a direct website booking.
-- The website supplies both with the enquiry (POST /api/event-inquiries);
-- branding is {logo_url, brand_color, header_bg}, cancel_url may contain
-- {id}, filled in with the appointment id when it is created. Run ONCE
-- directly against an already-populated database (NOT part of the normal
-- reset pipeline). Idempotent-safe via IF NOT EXISTS. Existing enquiries get
-- NULL for both and keep sending the plain email.

ALTER TABLE event_inquiry
  ADD COLUMN IF NOT EXISTS branding   JSONB,
  ADD COLUMN IF NOT EXISTS cancel_url TEXT;
