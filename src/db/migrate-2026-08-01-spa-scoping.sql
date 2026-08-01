-- One-time migration: introduce spa as a top-level entity and scope
-- spa_treatment/spa_therapist to it via spa_id.
-- Run ONCE directly against an already-populated database (NOT part of
-- the normal reset pipeline). Safe as a straight NOT NULL column add (no
-- default, no backfill) because spa_treatment and spa_therapist are
-- confirmed empty in every environment - nothing has ever seeded them.
-- See docs/superpowers/plans/2026-08-01-multi-spa-plan.md.

CREATE TABLE IF NOT EXISTS spa (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  phone       VARCHAR(30),
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE spa_treatment ADD COLUMN IF NOT EXISTS spa_id UUID NOT NULL REFERENCES spa(id);
ALTER TABLE spa_therapist ADD COLUMN IF NOT EXISTS spa_id UUID NOT NULL REFERENCES spa(id);

CREATE INDEX IF NOT EXISTS idx_spa_treatment_spa ON spa_treatment(spa_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_spa ON spa_therapist(spa_id);
