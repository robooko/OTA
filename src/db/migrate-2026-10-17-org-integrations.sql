-- Migration A (additive): per-org integrations + marina documents in the
-- org's own Google Drive. Spec: docs/superpowers/specs/2026-10-17-per-org-storage-google-drive-design.md
-- Safe under the old code. Migration B (migrate-2026-10-17-marina-document-drop-blob.sql)
-- drops the old blob columns later.

-- One row per org per provider. refresh_token / access_token hold
-- ciphertext only (src/lib/integrations.js encrypt); never returned to clients.
CREATE TABLE IF NOT EXISTS org_integration (
  clerk_org_id            VARCHAR(255) NOT NULL REFERENCES organization(clerk_org_id) ON DELETE CASCADE,
  provider                VARCHAR(30) NOT NULL,
  account_email           VARCHAR(255),
  refresh_token           TEXT,
  access_token            TEXT,
  access_token_expires_at TIMESTAMPTZ,
  settings                JSONB NOT NULL DEFAULT '{}',
  reconnect_required      BOOLEAN NOT NULL DEFAULT false,
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (clerk_org_id, provider)
);

ALTER TABLE marina_document ADD COLUMN IF NOT EXISTS drive_file_id TEXT;
ALTER TABLE marina_document ADD COLUMN IF NOT EXISTS drive_web_link TEXT;
ALTER TABLE marina_document ALTER COLUMN blob_pathname DROP NOT NULL;
