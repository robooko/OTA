-- One-time migration: link a property to its Sidon marina (step 1 of
-- unifying OTA and sidon-marina). Holds Sidon's marina owner id (the
-- org_... in marina.sidonmarine.uk/api/marina/public/<id>); null = no
-- marina, so the dashboard hides its Marina page.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS sidon_marina_id VARCHAR(100);
