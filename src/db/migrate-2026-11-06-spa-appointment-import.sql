-- The id an appointment had in the system it was imported from
-- (POST /api/spa/:spa_id/appointments/import); re-imports skip it.
ALTER TABLE spa_appointment ADD COLUMN IF NOT EXISTS external_ref VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spa_appointment_external_ref ON spa_appointment (property_id, external_ref) WHERE external_ref IS NOT NULL;
