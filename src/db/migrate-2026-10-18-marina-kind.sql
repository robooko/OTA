-- A marina is pontoon berths or a mooring field (buoys): maps draw a
-- berth as a turned slot or a swing circle accordingly.
ALTER TABLE marina ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'marina' CHECK (kind IN ('marina', 'mooring'));

-- Fox Mooring, Pevero Mooring, Pirates Bight (live ids; no-op elsewhere).
UPDATE marina SET kind = 'mooring' WHERE id IN (
  '1ebfd2c0-2dee-540e-be21-155cc89bb6f4', '76cd4e5e-92c0-5ac2-9f92-21aab398cafe', '7df7eec4-17ad-5674-9817-8c59a431c96a');
