-- One-time migration: add spa_therapist.clerk_user_id, an optional link to
-- the therapist's own staff login (mirrors spa_appointment.clerk_user_id,
-- which links the *guest* side instead). Lets the spa dashboard default a
-- linked therapist's own view to just their own appointments. Run ONCE
-- directly against an already-populated database (NOT part of the normal
-- reset pipeline). Idempotent-safe via IF NOT EXISTS. Preserves every
-- existing therapist row; clerk_user_id defaults to NULL for them.

ALTER TABLE spa_therapist
  ADD COLUMN IF NOT EXISTS clerk_user_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_spa_therapist_clerk_user ON spa_therapist(clerk_user_id);
