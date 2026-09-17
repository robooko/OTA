-- One-time migration: add proshop_order.confirmation_resend_email_id,
-- mirroring spa_appointment.confirmation_resend_email_id. Holds the Resend
-- id of the order confirmation email, and doubles as the "already sent"
-- guard -- an order becomes paid down three paths (confirm-payment, the
-- payment-intent already-succeeded branch, staff marking it paid), and the
-- guest should get exactly one receipt whichever one fired. Run ONCE
-- directly against an already-populated database (NOT part of the normal
-- reset pipeline). Idempotent-safe via IF NOT EXISTS. Existing orders keep
-- NULL, so a historical order that somehow transitions to paid again would
-- send one -- acceptable: they never received one at all.

ALTER TABLE proshop_order
  ADD COLUMN IF NOT EXISTS confirmation_resend_email_id VARCHAR(255);
