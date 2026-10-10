-- One-time migration: the linked Sidon marina's API key (mk_..., from the
-- Sidon dashboard), so OTA can read that marina's berth bookings server-side
-- for the dashboard's Marina page. Stored and handled like
-- stripe_secret_key: admin-only to set/clear, never returned by any GET.
--
-- Idempotent-safe via IF NOT EXISTS. Run ONCE directly against the
-- database (NOT part of the normal reset pipeline).

ALTER TABLE property ADD COLUMN IF NOT EXISTS sidon_marina_key TEXT;
