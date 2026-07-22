# API Key Auth for POST /api/guests and POST /api/bookings — Design

## Context

Today, `POST /api/guests` and `POST /api/bookings` (like every other route in `routes/guests.js` and `routes/bookings.js`) require a JWT `Authorization: Bearer` token, issued via `POST /api/auth/login`. `req.property_id` — used by every query in `controllers/guests.js` and `controllers/bookings.js` — comes exclusively from that token's `property_id` claim.

Separately, the restaurant/spa/golf/tours/equipment/proshop/room-service/beach-club modules use a different mechanism: `middleware/apiKey.js`'s `requireApiKey`, checking a single shared `X-Api-Key` header against `process.env.API_KEY` — one value for the whole deployment. Those modules work with just an API key because none of their tables carry a `property_id` at all (confirmed by inspecting `schema.sql`); there's no scoping ambiguity to resolve.

`guest` and `booking`, by contrast, are strictly property-scoped (`property_id NOT NULL`). This is the gap: allowing `X-Api-Key` to authenticate a request to these two endpoints requires deciding, per-request, which property it's for — since the key itself carries no property information.

**Goal:** let `POST /api/guests` and `POST /api/bookings` accept either the existing JWT or the shared `X-Api-Key`, without changing behavior for existing JWT-based callers, and without touching any other route.

## Design

**New middleware** — `authenticateOrApiKey` in `src/middleware/auth.js`, alongside the existing `authenticate`:

1. If `Authorization` header starts with `Bearer ` → delegate to the exact same logic `authenticate` already runs (JWT verify, `req.property_id` from the token's `property_id` claim, `req.user` set).
2. Else if `X-Api-Key` header equals `process.env.API_KEY` → read `property_id` from `req.body`:
   - Missing or not a valid UUID (reuse `isValidUuid` from `middleware/validate.js`) → `400 { error: "property_id is required and must be a valid UUID when authenticating with X-Api-Key" }`.
   - Valid UUID but no matching `property` row → `404 { error: "Property not found" }`.
   - Otherwise → `req.property_id = property_id`, continue. (`req.user` is left `undefined` in this path — nothing downstream in `createGuest`/`createBooking` reads `req.user`, so this is safe.)
3. Else (neither a valid Bearer token nor a valid API key) → `401 { error: "Missing or invalid Authorization header or X-Api-Key" }`.

**Route changes** — only these two lines change, in `routes/guests.js` and `routes/bookings.js` respectively:
```js
router.post('/', authenticateOrApiKey, ctrl.createGuest);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
```
Every other route on both resources (`GET /`, `GET /:id`, `PUT /:id`, `DELETE /:id`, plus `GET /lookup` and `GET /:id/summary` on guests) keeps using `authenticate` exactly as today.

**No controller changes** — `createGuest` and `createBooking` already only consume `req.property_id`; they don't care how it was populated.

**`property_id` under JWT auth**: if a JWT-authenticated caller also includes `property_id` in the body, it's silently ignored — `req.property_id` always comes from the token in that path, matching how every other field works today (body values are only ever read by the controller, which never reads `body.property_id`).

## Documentation (Swagger)

- Add an `apiKeyAuth` security scheme to `components.securitySchemes`: `{ type: 'apiKey', in: 'header', name: 'X-Api-Key' }`.
- On the `POST /api/guests` and `POST /api/bookings` path entries, add `security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]` (OpenAPI semantics: an array of alternatives is OR — either satisfies it), overriding the global default `security: [{ bearerAuth: [] }]`.
- Add `property_id: { type: 'string', format: 'uuid' }` to both request body schemas, with a description noting it's required only when authenticating via `X-Api-Key`.

## Trade-off (accepted, not a gap to close here)

`API_KEY` is one shared value across every property today — this is pre-existing, not introduced by this change (the restaurant/spa/etc. modules already work this way). Extending it to `guest`/`booking` creation means an `X-Api-Key` holder can create a guest or booking for **any** `property_id` they supply, not just one property. Introducing per-property API keys would close this, but is out of scope — it's a larger feature (new table, key issuance/rotation flow) not requested here.

## Verification

1. Local: `POST /api/guests` and `POST /api/bookings` with a JWT — confirm unchanged (`201`, same response shape as before).
2. Local: same two endpoints with `X-Api-Key` header and `property_id` in the body (using BBYC's id, `e1000000-0000-0000-0000-000000000004`) — confirm `201`, and the created rows have the right `property_id`.
3. Local: `X-Api-Key` with a missing `property_id` → `400`. `X-Api-Key` with a malformed (non-UUID) `property_id` → `400`. `X-Api-Key` with a well-formed but non-existent `property_id` → `404`. No `Authorization` and no `X-Api-Key` at all → `401`.
4. Local: confirm `GET /api/guests`, `GET /api/bookings`, `PUT`, `DELETE` still reject `X-Api-Key` (still JWT-only) — i.e. the change is scoped to exactly the two `POST` routes.
5. Repeat step 2 against live `otadb`/Render once local passes and the change is pushed.
