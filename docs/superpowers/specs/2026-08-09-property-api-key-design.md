# Per-Property API Keys — Design

## Context

`POST /api/guests`, `POST /api/bookings`, and `POST /api/restaurant/:restaurant_id/reservations` accept either a Clerk `Authorization: Bearer` token or a shared `X-Api-Key` header (`authenticateOrApiKey` in `src/middleware/auth.js`), per the `2026-07-22-guest-booking-api-key-design.md` spec. The `X-Api-Key` path checks the header against a single `process.env.API_KEY` value shared across the whole deployment, and reads which property the request is for from a client-supplied `property_id` in the body/query. That spec explicitly flagged this as an accepted trade-off: any holder of the shared key can create a guest or booking for *any* `property_id`, not just their own.

This change closes that gap by moving from one shared key to one key per `property`, looked up in the database — the key itself determines the property, so a client can no longer claim an arbitrary `property_id`.

**Out of scope:** `middleware/apiKey.js`'s `requireApiKey`, used by `beachClub`, `equipment`, `golf`, `proshop`, `roomService`, `spa`, and `tours`. None of those modules' tables carry a `property_id` (confirmed against `schema.sql` and the relevant controllers) — there's no property to scope a key to without a much larger scoping effort first, which isn't part of this change. Those routes keep using the shared `API_KEY` env var exactly as today.

## Design

### Data model

```sql
ALTER TABLE property ADD COLUMN api_key TEXT UNIQUE;
```

Key format: `prop_` followed by 64 hex characters (32 random bytes via `crypto.randomBytes(32).toString('hex')`) — the prefix makes the key type recognizable in logs without decoding anything. Stored in plaintext: the view endpoint (below) needs to return the existing key on demand, not just a hash, so plaintext is required, and it matches the security posture of the shared `API_KEY` env var it replaces.

A migration, `src/db/migrate-2026-08-09-property-api-key.sql`, adds the column and backfills every existing property (pgcrypto is already enabled in this DB):

```sql
ALTER TABLE property ADD COLUMN api_key TEXT UNIQUE;
UPDATE property SET api_key = 'prop_' || encode(gen_random_bytes(32), 'hex') WHERE api_key IS NULL;
```

Every property must have a key before cutover (next section), since the shared key is being fully replaced, not supplemented.

### Middleware change (`authenticateOrApiKey`, `src/middleware/auth.js`)

The `X-Api-Key` branch changes from comparing against `process.env.API_KEY` to a DB lookup:

```js
const key = req.headers['x-api-key'];
if (!key) {
  return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
}
const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1', [key]);
if (!rows.length) {
  return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
}
req.property_id = rows[0].id;
next();
```

- `property_id` is no longer read from `req.body`/`req.query` in this branch at all — the key determines the property, matching how the JWT branch already ignores any `property_id` the caller sends.
- The `400`/`404` branches for a missing/malformed/nonexistent `property_id` are removed from this path — there's nothing left for the caller to get wrong there.
- `process.env.API_KEY` is no longer referenced by `authenticateOrApiKey`. `middleware/apiKey.js` (`requireApiKey`) is untouched and keeps using it for the modules listed under "Out of scope."

No controller changes: `createGuest`, `createBooking`, `createReservation`, and `lookupGuest` already only consume `req.property_id`, however it was populated.

### New endpoint — view and rotate

New `src/routes/property.js` + `src/controllers/property.js`, mounted at `/api/property`:

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/property/api-key` | `authenticate`, `requireRole('admin')` | Returns `{ api_key }` for `req.property_id` |
| POST | `/api/property/api-key/rotate` | `authenticate`, `requireRole('admin')` | Generates a new key, persists it, returns `{ api_key }` |

- `GET`: `SELECT api_key FROM property WHERE id = $1` using `req.property_id` (set by Clerk auth from the caller's active org).
- `POST /rotate`: generate a fresh `prop_<64 hex>` key, `UPDATE property SET api_key = $1 WHERE id = $2 RETURNING api_key`. The old key stops working the instant this commits — no grace period, no multi-key support. Nothing in this design needs concurrent old/new keys, so none is built.
- Both routes require a Clerk session, not the API key itself — matches every other admin action in this app; you can't rotate a key using that same key.

## Documentation (Swagger)

- `src/docs/swagger.js`: on `POST /api/guests`, `POST /api/bookings`, `POST /api/restaurant/{restaurant_id}/reservations`, and `GET /api/guests/lookup`, remove the `property_id` body/query field description that says "Required only when authenticating with X-Api-Key" (no longer true — it's ignored now, not required) and instead note the key determines the property.
- Add the new `GET /api/property/api-key` and `POST /api/property/api-key/rotate` paths, both under `security: [{ bearerAuth: [] }]` (Clerk-only, no `apiKeyAuth` alternative — you can't use an API key to manage API keys).

## Trade-offs (accepted)

- **No key expiry/multi-key rotation window.** Rotating immediately invalidates the old key. If a property's integration needs a grace period to swap keys without downtime, this design doesn't provide one — out of scope, not requested.
- **Full replacement, not additive.** Once shipped, the old shared `API_KEY` no longer works on these three routes at all. Any existing caller must fetch its property's new key via the admin endpoint before this ships, or its requests start failing immediately.
- **`requireApiKey` modules unchanged.** `beachClub`, `equipment`, `golf`, `proshop`, `roomService`, `spa`, `tours` keep the single shared `API_KEY`. Bringing them into property scoping is a separate, larger project (their tables have no `property_id` at all today).

## Verification

1. Local: run the migration, confirm every existing `property` row has a non-null, unique `api_key`.
2. Local: `POST /api/guests` with a real property's `api_key` → `201`, row lands on that property. Wrong or missing key → `401`. The old shared `API_KEY` value → also `401` (confirms full replacement).
3. Local: repeat step 2's success case for `POST /api/bookings` and `POST /api/restaurant/:restaurant_id/reservations`, and for `GET /api/guests/lookup`.
4. Local: `GET /api/property/api-key` with a Clerk admin token → returns the key. Non-admin role → `403`. No token → `401`.
5. Local: `POST /api/property/api-key/rotate` → returns a new key; a follow-up guest/booking/reservation call using the *old* key now gets `401`; using the *new* key succeeds.
6. Confirm `requireApiKey`-gated routes (e.g. `POST /api/spa`) are unaffected — still accept the shared `API_KEY` exactly as before.
7. Repeat steps 2–5 against live once local passes and the change is deployed, using one of the already-provisioned live properties (e.g. FORGE).
