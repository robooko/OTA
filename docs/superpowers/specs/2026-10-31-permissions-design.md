# Permissions for users and API keys — design

Date: 2026-10-31. Status: draft for approval.

## Why

Housekeeping (see `2026-10-31-housekeeping-design.md`) adds room inspection. Today every signed-in staff member is equal, so a cleaner could open the app and pass their own room. That spec parks the problem with "anyone signed in can inspect for now; permissions on users and API keys are coming separately". This is that piece.

What exists: Clerk gives each org member one of two roles, `admin` or `staff`. OTA maps that straight through and gates 31 routes with `requireRole('admin')`; everything else is open to any staff login. API keys are one per property and one per org, on or off, and a key passes every admin gate (`requireRoleOrApiKey`). There is nothing in between on either rail.

## Governing rule

**Nothing gets narrower unless an admin narrows it.** Robert's prompts, websites and integrations run on today's keys and must not fail on deploy or ever after by default.

- Every key that exists today keeps doing everything. A key loses abilities only when an admin gives it a list.
- Admins pass every check. Staff keep everything they have now; the only new gates are on housekeeping inspection and housekeeping settings, which don't exist yet.
- When a check fails, the error names the missing permission in one line.

## Goals

1. **Named permissions.** A route can require one permission by name. Users and keys share one vocabulary, so one check on a route serves both rails.
2. **Staff grants.** An admin gives a staff member a set of permissions at a property.
3. **Several keys per property and per org**, each named, each enabled or disabled on its own, each either full (today's behaviour) or holding a list of permissions.
4. **Clear refusal.** `403 { error: 'Missing permission', permission: 'housekeeping.inspect' }`.
5. **Housekeeping is the first consumer**: `housekeeping.inspect` and `housekeeping.manage`.

## Non-goals

- Converting existing admin-only routes to named permissions. Follow-up, one route at a time, each its own small change.
- Gating any route that is open to all staff today.
- Module-level read/write scopes for keys (`bookings:read`, `proshop:write`). Add when a key actually needs narrowing to a module; until then a scoped key differs from a full key only on gated routes (see "What a scoped key can't do").
- Hashing keys at rest. Today they're plaintext and shown in the dashboard; unchanged.
- Keys belonging to a person (GitHub-style personal tokens). Every key today is held by a system, and a person who needs the API has a Clerk login.
- Clerk custom roles and permissions. Clerk's roles are per org; this needs per property.
- Dashboard UI. This spec is the API.

## Anti-goals (would make this a failure)

- Any existing key, website, prompt or integration losing an ability on deploy.
- A staff member locked out of something they can do today.
- An ambiguous 403.
- A deploy window where old code can't find the key columns. The live migration runs **before** pushing, and old code must keep working against the new schema for the minutes in between.

## Decided

**Vocabulary.** A permission is a lowercase dotted string `<module>.<action>`. The known names live in one list in code (`src/lib/permissions.js`). Setting an unknown name on a grant or key is a 400. Initial names:

| Name | Covers |
|---|---|
| `housekeeping.inspect` | Record an inspection (pass / fail a clean). |
| `housekeeping.manage` | Checklist items, stayover rule, minibar catalogue and lists. |

Cleaning itself (board, claim, start, finish, record minibar, tick extras) stays open to any staff login. That is the status quo for every staff action, and the housekeeping board is deliberately shared. Whether an inspector may pass a clean they did themselves is a housekeeping rule, not a permission.

**Who passes a check.** `requirePermission(name)` middleware, used after an `authenticate*`:

| Caller | Result |
|---|---|
| Clerk admin | pass |
| Clerk staff | pass if their grant at `req.property_id` lists the name |
| API key, `permissions IS NULL` (full key) | pass |
| API key with a list | pass if the list includes the name |
| anything else | `403 { error: 'Missing permission', permission: name }` |

Grants are per property, so on an org-level route (`authenticateOrg`, no `req.property_id`) only admins and full keys pass. That's acceptable: none of the org routes need a named permission today.

**What a scoped key can't do.** `requireRole` is untouched. `requireRoleOrApiKey('admin')` passes a full key exactly as today; a scoped key (one given a list) fails it with `403 { error: 'This key is scoped; this route needs a full key or a named permission' }`. Those six routes have no permission name yet; when one needs to be reachable by a scoped key, it gets a name (follow-up).

**Staff grants.** New table:

```
staff_permission
  property_id    UUID NOT NULL REFERENCES property(id) ON DELETE CASCADE
  clerk_user_id  VARCHAR(100) NOT NULL
  permissions    TEXT[] NOT NULL DEFAULT '{}'
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  updated_by     VARCHAR(100)          -- clerk user id of the admin
  PRIMARY KEY (property_id, clerk_user_id)
```

Per property, not per org, because orgs have several hotels and a head housekeeper belongs to one. The dashboard can offer "apply to all my hotels" later by calling the endpoint per property.

Endpoints, staff rail, admin only:

- `GET /api/property/staff` — the org's members from Clerk (`clerkClient.organizations.getOrganizationMembershipList`): `clerk_user_id`, name, email, `role` (admin / staff), plus `permissions` from this property's grant (empty array when none). Admins are returned with their role; the dashboard shows "admin: everything".
- `PUT /api/property/staff/:clerk_user_id/permissions` body `{ permissions: string[] }` — upsert the grant. Unknown names 400. A user who isn't a member of the org 404 (one Clerk call). Returns the row.

A grant for someone who later leaves the org is harmless: no token ever matches it.

`GET /api/auth/me` gains `permissions: string[]`, the caller's grant at the resolved property (empty for admins, who pass everything, and for staff with no grant). The housekeeping app uses it to decide whether to show Inspect and Manage instead of discovering the 403 by tapping. *(Claude's call.)*

**API keys.** New table; existing keys are copied in and keep their exact values, so nothing anyone holds changes:

```
api_key
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
  property_id   UUID REFERENCES property(id) ON DELETE CASCADE
  clerk_org_id  VARCHAR(255) REFERENCES organization(clerk_org_id) ON DELETE CASCADE
  name          VARCHAR(100) NOT NULL DEFAULT 'Default'
  key           TEXT NOT NULL UNIQUE
  permissions   TEXT[]                 -- NULL = everything (full key)
  enabled       BOOLEAN NOT NULL DEFAULT true
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  created_by    VARCHAR(100)           -- clerk user id; NULL for migrated rows
  CHECK ((property_id IS NULL) <> (clerk_org_id IS NULL))
```

A property key has `property_id`; an org key has `clerk_org_id`. Migration copies `property.api_key / api_key_enabled` and `organization.api_key / api_key_enabled` into rows named `Default`, with `permissions NULL`.

**The old columns stay for now.** `resolveSiteProperty`, `authenticateOrgKey` and the key controllers read and write only the new table. The four legacy columns are left in place, marked deprecated in `schema.sql`, so that production code still running during the migrate-then-push window keeps resolving keys. A later cleanup migration drops them once the new code is live.

**Existing key endpoints keep working.** `GET /api/property/api-key`, `POST .../rotate`, `.../disable`, `.../enable` and their `/api/organization/api-key` twins act on the row named `Default` for that property or org. Same response shapes and the same create behaviour as today, so the dashboard is untouched: the property's GET answers `{ api_key: null, api_key_enabled: true }` until rotate mints one (the dashboard's "Generate" state; disable/enable on a keyless property are 404), while the org's GET creates the row on first call as `ensureOrg` did. One `Default` row per owner is enforced by partial unique indexes, so two tabs restoring at once can't mint two. *(Corrected after review: the draft said both GETs create on read, which was only ever true for orgs.)*

New endpoints, staff rail, admin only, mirrored at `/api/property/api-keys` and `/api/organization/api-keys`:

- `GET /` — list `{ id, name, key, permissions, enabled, created_at, created_by }`. The key value is shown, as today.
- `POST /` body `{ name, permissions? }` — `permissions` omitted or `null` = full key. Unknown permission names 400. The name `Default` is reserved for the legacy endpoints' row and is a 400 here, so "the row named Default" is always one row. Returns 201 with the row. *(Claude's call.)*
- `PUT /:id` body `{ name?, permissions?, enabled? }` — `permissions: null` makes it full again.
- `DELETE /:id` — revoke for good. Deleting the `Default` row is allowed; the property's legacy GET goes back to `null` and rotate mints a fresh one, the org's GET recreates one.

**Resolving a key.** `resolveSiteProperty` and `authenticateOrgKey` look up `SELECT id, property_id, clerk_org_id, permissions FROM api_key WHERE key = $1 AND enabled = true`. Property key → its property, routing headers ignored; org key → org routing as today. Both set `req.api_key = { id, permissions }` so `requirePermission` and `requireRoleOrApiKey` can read it. `req.auth_method = 'api_key'` and the rate limiter (keyed by the raw header) are unchanged.

**Housekeeping.** This supersedes the housekeeping spec's "anyone can inspect" non-goal. Inspection endpoints take `requirePermission('housekeeping.inspect')`; checklist items, stayover settings and minibar catalogue/list writes take `requirePermission('housekeeping.manage')`. The public minibar list on the site rail has no gate.

**Ship order.** Permissions ships first and standalone; neither feature exists in code yet. This spec ships the two names in `permissions.js` and the middleware, and its check script exercises the middleware directly. The housekeeping plan owns the gate lines on its routes and the 403 in its swagger, and depends on this landing first. *(Claude's call.)*

**Docs and checks.** Swagger entries for the new endpoints and the two 403 shapes. `scripts/check-permissions.js` runs inside a rolled-back transaction, following the existing `check-*.js` pattern: migrated Default key resolves and passes a gate; a scoped key fails a gate it doesn't list and passes one it does; a scoped key fails `requireRoleOrApiKey`; staff without a grant fails, with a grant passes; admin passes with no grant; unknown permission name is a 400.

**Migration.** `src/db/migrate-2026-10-31-permissions.sql` plus `schema.sql`. Run on live **before** pushing (OTA main auto-deploys).

## Left to the builder

- Whether `requirePermission` reads the grant with one query per request or caches briefly. One indexed query is fine.
- Exact response shapes, validation messages, swagger wording, and the check script's cases beyond those listed.
- How `created_by` is populated from `req.user.id` and that `GET /api/property/staff` handles Clerk pagination for large orgs.
- Index on `api_key(key)` is the unique constraint; add nothing else unless a query needs it.
- Clerk's membership list reports roles as `org:admin` / `org:member`, while session tokens carry `admin` / `member` under `o.rol`. Normalise to `admin` / `staff` in one place.
- About ten `scripts/check-*.js`, plus `scripts/import-sidon-marina.js` and `scripts/seed-marina-demo.js`, insert `property.api_key` directly and then authenticate through it. Once `resolveSiteProperty` reads only the new table they must insert `api_key` rows instead. In scope.

## Follow-ups (not in this spec)

- Convert admin-only routes to named permissions, one at a time, as someone needs a staff member or key to reach one.
- Module-level key scopes, if a key ever needs narrowing to a module rather than to a named action.
- Cleanup migration dropping `property.api_key`, `property.api_key_enabled`, `organization.api_key`, `organization.api_key_enabled`.
