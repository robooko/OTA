-- One-time migration: long-term berth holders. term 'long' = an open-ended
-- contract; checkout (action end) frees the berth for resale, return
-- (action return) opens a linked booking. contract_until is a soft expiry
-- (informational only). return_notice_days is the contract's notice
-- period, snapshotted onto the booking from its template.

ALTER TABLE marina_booking
  ADD COLUMN IF NOT EXISTS term VARCHAR(5) NOT NULL DEFAULT 'short',
  ADD COLUMN IF NOT EXISTS contract_until DATE,
  ADD COLUMN IF NOT EXISTS return_notice_days INT,
  ADD COLUMN IF NOT EXISTS previous_booking_id UUID REFERENCES marina_booking(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE marina_booking ADD CONSTRAINT marina_booking_term_check CHECK (term IN ('short', 'long'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE marina_contract_template
  ADD COLUMN IF NOT EXISTS return_notice_days INT;
