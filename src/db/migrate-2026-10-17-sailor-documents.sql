-- Shared sailor documents: one set per sailor (Clerk-verified email), held by
-- OTA; versions are the sailor's files; approvals are per marina per version.
-- Spec: docs/superpowers/specs/2026-10-17-shared-sailor-documents-design.md
CREATE TABLE IF NOT EXISTS sailor_document (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(255) NOT NULL, -- lower-cased, Clerk primary + verified
  type           VARCHAR(30) NOT NULL CHECK (type IN ('insurance', 'acord25', 'registration', 'uscg_cod', 'passport', 'safety')),
  extracted_data JSONB, -- advisory only
  expiry_date    DATE, -- set by the sailor or staff, never by extraction
  created_at     TIMESTAMPTZ DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sailor_document_email ON sailor_document (email) WHERE deleted_at IS NULL;

-- blob_pathname is a private-store path, never a URL.
CREATE TABLE IF NOT EXISTS sailor_document_version (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES sailor_document(id) ON DELETE CASCADE,
  blob_pathname   TEXT NOT NULL,
  file_name       VARCHAR(255),
  content_type    VARCHAR(50) NOT NULL,
  size_bytes      INT NOT NULL,
  extracted_data  JSONB,
  uploaded_at     TIMESTAMPTZ DEFAULT now(),
  file_deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sailor_document_version_document ON sailor_document_version (document_id);

CREATE TABLE IF NOT EXISTS sailor_document_approval (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  UUID NOT NULL REFERENCES sailor_document_version(id) ON DELETE CASCADE,
  marina_id   UUID NOT NULL REFERENCES marina(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES property(id),
  status      VARCHAR(20) NOT NULL CHECK (status IN ('approved', 'rejected')),
  notes       TEXT,
  staff_user  VARCHAR(255),
  decided_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (version_id, marina_id)
);

-- true only when contact_email came from a sailor's Clerk token: the one
-- link that lets staff see that sailor's documents.
ALTER TABLE marina_booking ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
