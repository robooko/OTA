# Staff auth via Clerk (replaces the password/JWT system)

## Context

Staff (`api_user`) authentication today is a self-contained bcrypt + JWT
system: `POST /api/auth/register` (admin-gated, creates a staff/admin
account under the caller's own property), `POST /api/auth/login`
(email/password → our own `JWT_SECRET`-signed token), and `authenticate`
(`src/middleware/auth.js`) verifies that token on every staff-gated
request, setting `req.user` and `req.property_id`.

Clerk is already used elsewhere in this codebase, but only on the *guest*
side: `guest.clerk_user_id` is a plain opaque string passed through from
whatever frontend calls this API — the backend never verifies a Clerk
token for guests, and guest-facing writes are gated by a shared
`X-Api-Key` instead (`authenticateOrApiKey`). Clerk credentials
(`CLERK_SECRET_KEY`, `PUBLIC_CLERK_PUBLISHABLE_KEY`) are already present
in `.env`, but no Clerk SDK is installed yet.

This project is an API with no frontend of its own — whatever client(s)
call it already use Clerk for their own signup/login UI and session
management, including Clerk **Organizations** for team/tenant grouping.
The request: stop duplicating identity (no local password, no local JWT
for staff) and let this API's only job be resolving "which `property`
does this caller's Clerk Organization correspond to."

## Goals

- `authenticate` verifies a Clerk session token (via Clerk's backend SDK)
  instead of our own `JWT_SECRET`-signed token.
- `property` gains a `clerk_org_id` column linking it to a Clerk
  Organization.
- The first authenticated request from a brand-new Clerk Organization
  (one with no matching `property` row yet) auto-provisions that
  property. This **is** the self-service "signup creates a property"
  behavior — no dedicated signup endpoint.
- Every already-property-scoped module (guests, rooms, room types,
  availability, bookings, extras, restaurant) keeps working completely
  unmodified — they only ever consume `req.property_id` / `req.user`,
  never query `api_user` directly, so the contract those two request
  properties provide is preserved exactly.
- `authenticateOrApiKey`'s guest-facing `X-Api-Key` path is untouched;
  only what "Bearer token" resolves to, underneath, changes.
- Remove `register`, `login`, `listUsers`, `updateUser` — all superseded
  by Clerk's own Organization membership, invites, and roles.

## Non-goals

- No change to guest-side Clerk usage — `guest.clerk_user_id` stays a
  plain passthrough field, unrelated to this work.
- Not dropping the `api_user` table. It becomes unused by application
  code but is left in place (non-destructive), matching this project's
  existing migration convention. A later cleanup can drop it once nothing
  references it in production for a while.
- Not proxying Clerk's Organization/membership/invite APIs through this
  API. Team management (inviting staff, changing roles, removing members)
  happens entirely in Clerk, via whatever frontend/dashboard the caller
  uses — this API never brokers it.
- No UI or endpoint for "create an Organization." That's Clerk's own
  hosted/embedded component on the calling frontend; this API only reacts
  to a token that already has an `org_id`.
- Not linking Clerk Organizations to the 15 properties that already exist
  in production today (seeded manually, no Clerk org). Their
  `clerk_org_id` stays `NULL` until/unless someone deliberately links one
  — how that linking happens for *existing* properties is a separate,
  later decision, out of scope here.

## Data model

```sql
ALTER TABLE property ADD COLUMN clerk_org_id VARCHAR(255) UNIQUE;
```

Nullable — existing properties have no Clerk org yet (see Non-goals).
Postgres `UNIQUE` already treats multiple `NULL`s as distinct, so no
partial-index trick is needed. One new index (the unique constraint
itself provides it).

## Auth flow

### Dependencies

- Add `@clerk/backend` (framework-agnostic; `authenticateRequest`/
  `verifyToken`, fits directly into the existing hand-written
  `authenticate` function shape without adopting a new middleware
  pattern).
- Remove `jsonwebtoken` and `bcrypt` — confirmed via full-codebase grep to
  be used only in `src/controllers/auth.js` and `src/middleware/auth.js`,
  both rewritten/deleted by this change. `JWT_SECRET`/`JWT_SECRET_LIVE`
  in `.env` become dead (left in place, not required to remove).

### `authenticate` (rewritten)

Replaces `jwt.verify(token, JWT_SECRET)` with Clerk verification:

1. Verify the Bearer token via Clerk's SDK. Invalid/expired/missing →
   `401`, same contract as today (`{ error: 'Missing or invalid
   Authorization header' }` / `{ error: 'Invalid or expired token' }`).
2. Read the active Organization off the verified claims: `claims.o?.id`
   for the org id, `claims.o?.rol` for the role. **Confirmed empirically
   against this project's actual Clerk instance** (not assumed): Clerk
   issues "v2" compact session tokens, where org info is nested under a
   short `o` claim (`{ id, rol, slg }`), not flat `org_id`/`org_role`
   claims — and the role value is the short form `"admin"`, not
   `"org:admin"` (that longer form is what the *Backend API*'s
   organization-membership endpoints return; the session token's compact
   claims use the short form). `@clerk/backend`'s `verifyToken` returns
   the raw JWT payload with no renaming, so `authenticate` must read
   `claims.o` directly, not `claims.org_id`/`claims.org_role`. No `o`
   claim (personal Clerk account, no active organization selected) → `401
   {"error": "An organization context is required"}` — new failure mode,
   since this API's whole model requires one.
3. `SELECT id FROM property WHERE clerk_org_id = $1`:
   - **Found:** `req.property_id = property.id`.
   - **Not found:** fetch the Organization's name from Clerk
     (`clerkClient.organizations.getOrganization`), `INSERT INTO property
     (name, clerk_org_id) VALUES (...) RETURNING id`, use the new id.
     This is the auto-provisioning step — the very first API call from a
     new Organization creates its property, invisibly.
4. `req.user = { id: <clerk userId>, role: mapRole(claims.o.rol) }`.
   `mapRole` is confirmed (not assumed) against a real token from this
   instance: `'admin' → 'admin'`, everything else (e.g. `'member'`) →
   `'staff'`.
5. `next()`.

### `requireRole` (unchanged)

Still checks `req.user.role` against the allowed list — same function,
same shape. It becomes unused immediately after this change (every route
that called it is deleted below), kept as-is for future use rather than
removed, since the mechanism itself isn't what's changing.

### `authenticateOrApiKey` (unchanged code, different meaning underneath)

Its Bearer-token branch calls `authenticate` exactly as it does today —
now that resolves via Clerk instead of our own JWT, but the function
itself needs no edit. Its `X-Api-Key` branch (the guest-facing path) is
completely untouched.

## API surface changes

**Delete:** `POST /api/auth/register`, `POST /api/auth/login`, `GET
/api/auth/users`, `PUT /api/auth/users/:id`, and their controller
functions (`register`, `login`, `listUsers`, `updateUser` in
`src/controllers/auth.js`).

**Keep, repurpose:** `GET /api/auth/me` — returns `{ property_id: req.property_id, role: req.user.role }` directly from what `authenticate` already resolved, with no additional DB query.

**Swagger:** remove the deleted paths from `src/docs/swagger.js`; update
the `bearerAuth` security scheme's description to note it's now a Clerk
session token, not this API's own JWT; update `/auth/me`'s documented
response shape.

## Migration & rollout

Following this project's non-destructive migration convention:

- `schema.sql`: `property`'s definition gains `clerk_org_id VARCHAR(255)
  UNIQUE` directly, for fresh installs.
- New one-time migration file: `ALTER TABLE property ADD COLUMN IF NOT
  EXISTS clerk_org_id VARCHAR(255); CREATE UNIQUE INDEX IF NOT EXISTS ...`
  (or an inline `UNIQUE` constraint add) for the already-populated
  database. Purely additive — no backfill needed, since no existing
  property has a Clerk org to backfill from.
- Run against local first, verify, then production, then deploy — same
  two-step process used throughout this project's prior migrations.

## Testing approach

This is a different kind of verification than this project's prior
DB-and-curl-only changes: exercising the real auth path requires an
actual Clerk Organization and a real Clerk session token for it. This is
solved and repeatable — no manual step or waiting on a human required:

1. `clerk api /sign_in_tokens -X POST -d '{"user_id":"<test user id>"}'`
   (Clerk CLI, reads `CLERK_SECRET_KEY` from `.env` automatically) returns
   a one-time sign-in `url`.
2. A real browser (this project has Playwright browser tooling available)
   navigates to that URL, which signs in as the test user and — since
   they belong to an Organization — prompts to choose it; selecting it
   completes the sign-in with an active org context.
3. `window.Clerk.session.getToken({ skipCache: true })`, evaluated in that
   browser page, returns a fresh, real, verifiable session token.

A pre-provisioned test user (`ota-dashboard-test@example.com`) and test
Organization (`OTA Test Org`) already exist in this project's Clerk
instance for exactly this purpose. **Session tokens are short-lived
(~60 seconds)** — mint a fresh one immediately before each check that
needs one; don't reuse one token across multiple verification steps
separated by more than a few seconds of wall-clock time.

Manual checks once a real token is available:

1. Request with a valid token for a brand-new Organization (no matching
   `property` row) → succeeds, a new `property` row appears with the
   correct `clerk_org_id` and a name matching the Clerk Organization.
   Repeating the same request does **not** create a second property (the
   lookup-then-create logic is idempotent per org).
2. Request with a valid token for an Organization that already maps to a
   `property` → resolves to the existing row, no duplicate.
3. Request with a valid token but no active Organization selected →
   `401`.
4. Request with no token, or an invalid/expired one → `401` (unchanged
   from today's behavior).
5. An existing already-scoped endpoint (e.g. `GET /api/restaurant`) still
   works end-to-end through the new `authenticate` — confirms the
   `req.property_id` contract didn't break for downstream modules that
   were not touched by this change.
6. The guest-facing `authenticateOrApiKey` / `X-Api-Key` path still works
   unaffected — regression check that this change didn't touch it.
