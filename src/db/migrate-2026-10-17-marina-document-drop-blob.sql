-- Migration B: marina documents no longer have an OTA-stored file.
-- Spec: docs/superpowers/specs/2026-10-17-per-org-storage-google-drive-design.md
--
-- Run ONLY when all three hold:
--   1. the Drive-backed code (no blob_pathname / file_deleted_at reads) serves on live;
--   2. scripts/purge-marina-document-files.js --commit has run on live;
--   3. OTA cutover/cleanup is merged (it deletes the retired Sidon importer,
--      which still writes marina_document.blob_pathname).
ALTER TABLE marina_document DROP COLUMN IF EXISTS blob_pathname;
ALTER TABLE marina_document DROP COLUMN IF EXISTS file_deleted_at;
