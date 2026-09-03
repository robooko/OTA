-- Post-visit Google review requests (spa module) -- see
-- docs/superpowers/specs/2026-09-01-spa-review-requests-design.md.
--
-- property: off by default per-property, configured on the same
-- Settings -> Branding screen as email_branding/email_cancel_url.
-- spa_appointment: send record, mirrors confirmation_resend_email_id.
-- review_request_opt_out: property-scoped so opting out of one venue's
-- request says nothing about another the same person visits.
--
-- Idempotent via IF NOT EXISTS.

ALTER TABLE property
  ADD COLUMN IF NOT EXISTS review_request_enabled       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_url                   TEXT,
  ADD COLUMN IF NOT EXISTS review_request_delay_mins    INT NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS review_request_cooldown_days INT NOT NULL DEFAULT 90;

ALTER TABLE spa_appointment
  ADD COLUMN IF NOT EXISTS review_request_sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_request_resend_email_id TEXT,
  ADD COLUMN IF NOT EXISTS review_request_attempts        SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_spa_appointment_review_pending
  ON spa_appointment (property_id, appointment_date)
  WHERE review_request_sent_at IS NULL AND status = 'confirmed' AND contact_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS review_request_opt_out (
  property_id UUID NOT NULL REFERENCES property(id),
  email       VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (property_id, email)
);
