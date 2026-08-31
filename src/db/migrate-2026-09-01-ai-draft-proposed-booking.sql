-- Booking-on-approval for AI reply drafts: the model proposes one specific
-- slot (treatment/date/time) alongside the draft; approving or auto-sending
-- the draft creates the real spa appointment just before the reply email is
-- sent. booked_appointment_id records the outcome and guards a send retry
-- (after a Resend failure) from booking the slot twice.
--
-- Idempotent via IF NOT EXISTS.

ALTER TABLE event_inquiry_ai_draft
  ADD COLUMN IF NOT EXISTS proposed_treatment_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS proposed_date DATE,
  ADD COLUMN IF NOT EXISTS proposed_time TIME,
  ADD COLUMN IF NOT EXISTS booked_appointment_id UUID REFERENCES spa_appointment(id);
