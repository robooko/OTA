-- One-time migration: booking_cancel_score, cancellation-risk scores written
-- by an external ML job. Append-only so the score a booking had before it
-- cancelled is kept for evaluating the model; payloads show the latest.

CREATE TABLE IF NOT EXISTS booking_cancel_score (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  booking_id  UUID         NOT NULL REFERENCES booking(id) ON DELETE CASCADE,
  score       NUMERIC(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  model       VARCHAR(100) NOT NULL,
  scored_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_cancel_score_latest
  ON booking_cancel_score(booking_id, scored_at DESC);
