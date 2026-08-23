-- One-time migration: lets a property store its own Stripe secret key, so
-- the restaurant reservation flow can create payment intents / holds under
-- that property's own Stripe account rather than a shared admin key. Same
-- shape as property.vercel_pat (plain TEXT, admin-only read/write, never
-- returned to the client -- only a "configured" boolean is).

ALTER TABLE property ADD COLUMN IF NOT EXISTS stripe_secret_key TEXT;
