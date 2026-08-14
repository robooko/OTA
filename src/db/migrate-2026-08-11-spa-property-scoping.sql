-- One-time migration: add property_id to spa, spa_treatment, spa_therapist,
-- spa_slot, and spa_appointment. Unlike tours, real data exists on both
-- databases (confirmed before writing this migration: local has 3 spas,
-- live has 1 with 6 real appointments and 740 slots), so this uses the
-- restaurant module's nullable -> backfill -> NOT NULL sequence, not a
-- direct NOT NULL add.
--
-- Backfill is id-based, not name-based: "Pirates Bight Spa" exists on
-- both databases but maps to a DIFFERENT property on each (FORGE live,
-- Robs local), so matching by name would be ambiguous/wrong depending on
-- which database this runs against. Each UPDATE below targets a specific
-- known id; on a database where that id doesn't exist, the UPDATE is a
-- harmless no-op (0 rows matched) -- this makes the same file safe to run
-- unchanged against both local and live.
--
-- Idempotent-safe throughout. Run ONCE directly against an
-- already-populated database (NOT part of the normal reset pipeline).

ALTER TABLE spa             ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_treatment   ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_therapist   ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_slot        ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS property_id UUID REFERENCES property(id);

-- Live's Pirates Bight Spa -> FORGE (no-op on local, that id doesn't exist there)
UPDATE spa SET property_id = 'b7a4c969-5e82-4c26-a587-17d2ab74858e'
WHERE id = '6ecb0669-d3f5-4765-82f8-53fb5d6eb116' AND property_id IS NULL;

-- Everything else still unmapped (all 3 local spas, on local; nothing left on live) -> Robs
UPDATE spa SET property_id = 'a3e548af-a71d-46c0-ba61-f1f702e495be'
WHERE property_id IS NULL;

UPDATE spa_treatment st SET property_id = s.property_id
FROM spa s WHERE s.id = st.spa_id AND st.property_id IS NULL;

UPDATE spa_therapist th SET property_id = s.property_id
FROM spa s WHERE s.id = th.spa_id AND th.property_id IS NULL;

UPDATE spa_slot ss SET property_id = th.property_id
FROM spa_therapist th WHERE th.id = ss.therapist_id AND ss.property_id IS NULL;

UPDATE spa_appointment sa SET property_id = ss.property_id
FROM spa_slot ss WHERE ss.id = sa.slot_id AND sa.property_id IS NULL;

ALTER TABLE spa             ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_treatment   ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_therapist   ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_slot        ALTER COLUMN property_id SET NOT NULL;
ALTER TABLE spa_appointment ALTER COLUMN property_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spa_property             ON spa(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_treatment_property    ON spa_treatment(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_therapist_property    ON spa_therapist(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_slot_property         ON spa_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_spa_appointment_property  ON spa_appointment(property_id);
