# Multi-property per organization, with domain/path routing for one website build

**Date:** 2026-10-11
**Status:** Design approved in conversation; awaiting written-spec review
**Follow-up (separate spec):** channel manager

## Goal

One Clerk organization owns several hotels (`property` rows). One website
build serves all of them, routed either by **domain** (`seaview-hotel.com`,
`harbour-hotel.com`) or by **path** on a group domain (`mygroup.com/seaview`),
and reads/books against the right hotel's inventory. Dashboard staff switch
between their org's hotels.

## Current state

- `property.clerk_org_id` is `UNIQUE` (`schema.sql:13`): one org = one
  property. `authenticate` (`src/middleware/auth.js:40-54`) maps the token's
  `o.id` to that property and auto-creates it (plus starter tokens) on first
  sight. The UNIQUE constraint is what keeps two concurrent first requests
  from creating two properties today.
- Property selection happens in `authenticate` / `authenticateOrApiKey`, with
  one exception: `GET /api/availability/search`
  (`src/controllers/availability.js:68-72`) does its own per-property key
  lookup and falls back to `?property_id=`. Every module table is already
  `property_id`-scoped -- only property *selection* is missing.
- Websites call OTA server-side with a per-property `X-Api-Key`
  (`property.api_key`), so one build is bound to one hotel.
- `property_website` (`property_id`, `url`, `label`, `status`) already lists
  each property's sites; `createWebsite`/`updateWebsite` validate `url` as
  http(s).
- MCP (`POST /api/mcp`, `src/routes/mcp.js`) re-calls the API over loopback,
  forwarding only `X-Api-Key` and `Authorization`.

## Decisions

| Question | Decision |
|---|---|
| Who owns host/slug → property mapping | OTA (not website env config) |
| Domain source | Existing `property_website.url`; no new column, no uniqueness index |
| Path source | New nullable `property.slug`, unique within an org |
| Website credential | New org-level API key; per-property keys keep working unchanged |
| Billing, Stripe, Vercel, currency, timezone | Stay per property |
| Hotel selection | `X-Property-Id` (staff and org key); org key also `X-Property-Slug`, `X-Site-Host` |
| Ambiguous request | `400`, never a silent default |
| Selector outside the caller's org | `404` (does not leak existence) |

## 1. Data model

Two migrations, mirrored into `schema.sql` (remove `UNIQUE` from
`clerk_org_id`, add `slug`, the index, and the `organization` table):

`src/db/migrate-2026-10-11-multi-property-per-org.sql` -- additive, runs
before the code deploy:

```sql
-- Path routing (/seaview); unique within an org, NULL until set.
-- Leading clerk_org_id also serves the org's property lookups.
ALTER TABLE property ADD COLUMN IF NOT EXISTS slug VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS property_org_slug_key ON property(clerk_org_id, slug);

-- Org-level website key. Org name/members/roles stay in Clerk.
CREATE TABLE IF NOT EXISTS organization (
  clerk_org_id     VARCHAR(255) PRIMARY KEY,
  api_key          TEXT UNIQUE,
  api_key_enabled  BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now()
);
```

`src/db/migrate-2026-10-11-property-org-not-unique.sql` -- runs only once the
locked auto-create (§2) is live:

```sql
ALTER TABLE property DROP CONSTRAINT IF EXISTS property_clerk_org_id_key;
```

(`property_clerk_org_id_key` is the name both the inline `UNIQUE` in
`schema.sql` and `migrate-2026-08-09-property-clerk-org.sql` produce. The
pre-flight confirms it on the live DB via `pg_constraint`.)

**No host index.** Two orgs listing the same domain is harmless because host
lookups never cross orgs (§2). Two hotels in one org sharing a host (a group
domain with path routing) is legitimate and resolves through the slug. So the
domain needs no DB-level uniqueness, and website creates/updates need no new
409.

### Host normalisation

The JS helper `hostKey(input)` in `src/lib/siteHost.js` is the only
definition, and there is no SQL equivalent:

```js
// Bare host ("Seaview-Hotel.com:443") or full URL -> "seaview-hotel.com".
// URL does lowercasing, punycode, and drops port/userinfo/path/query.
function hostKey(input) {
  if (!input) return null;
  try {
    const s = String(input).trim();
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/\.$/, '').replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
```

## 2. Auth (`src/middleware/auth.js`)

Controllers keep reading `req.property_id`. Two exported resolution functions
take `db` (default `pool`, matching `claimDue(db = pool)`), so the check
script can drive them inside a rolled-back transaction:

- `resolveStaffProperty(db, orgId, requestedId, orgName)` → `{ propertyId }`
  or `{ status, error }`
- `resolveSiteProperty(db, { key, propertyId, slug, host })` →
  `{ propertyId, clerkOrgId? }`, `{ status, error }`, or `null` when the key
  matches nothing

### Staff (Clerk bearer)

`authenticateOrg`: verifies the token, requires `o.id`, sets
`req.clerk_org_id`, `req.user`, `req.auth_method = 'bearer'`. No property.

`authenticate` = `authenticateOrg` then `resolveStaffProperty`:

1. `SELECT id, status FROM property WHERE clerk_org_id = $1` (all statuses).
2. **No rows at all → locked auto-create.** The Clerk org name is fetched
   *before* the transaction, and only on this branch. Then, on one client:
   `BEGIN`; `SELECT pg_advisory_xact_lock(hashtext('property-autocreate:' || $1))`;
   re-run the SELECT; `INSERT` only if it is still empty; `COMMIT`.
   `grantStarter` runs after the commit, only when this request inserted.
   The losing concurrent request sees the winner's row on re-select.
3. Rows exist but none `active` → `403 { error: "This organization has no active properties" }`.
   It never auto-creates again.
4. `X-Property-Id` sent → must be a valid UUID of one of the org's **active**
   rows, else `404 { error: "Property not found" }`.
5. No header, exactly 1 active → that one.
6. No header, 2+ active → `400 { error: "X-Property-Id is required: this organization has multiple properties" }`.

### Website keys

`authenticateOrApiKey` (after `apiKeyRateLimiter`, as today) and
`searchAvailability` both call `resolveSiteProperty`:

1. Key matches an enabled `property.api_key` → that property. **Unchanged**,
   and routing headers are ignored.
2. Key matches an enabled `organization.api_key` → resolve among that org's
   **active** properties using the first selector present:
   - `X-Property-Id` → that id (valid UUID, in the org)
   - `X-Property-Slug` → `slug = $`
   - `X-Site-Host` → load the org's active properties' active
     `property_website.url`s and keep the properties where
     `hostKey(url) === hostKey(header)`. 0 → 404; exactly 1 property → it;
     2+ (a shared group domain) → `400 { error: "X-Property-Slug is required: this host serves multiple properties" }`.
   - none → the org has exactly 1 active property → it; 0 → 404;
     2+ → `400 { error: "X-Property-Id, X-Property-Slug or X-Site-Host is required: this organization has multiple properties" }`
   - a selector sent but unmatched → `404 { error: "Property not found" }`
3. Neither → `null` → `401`, same message as today.

`authenticateOrApiKey` sets `req.auth_method = 'api_key'` for both key kinds,
so join codes and `requireRoleOrApiKey` behave as now. For the org key it also
sets `req.clerk_org_id`.

`X-Site-Host` exists because the site calls OTA server-side, so OTA's own
`Host` is OTA. Trusting the header is safe because it only selects among the
key's own org's properties.

Rate limiting keys on the raw `X-Api-Key` (+ `X-Client-IP`), so an org key's
limit is shared across its hotels. Accepted for now.

### `authenticateOrgKey`

Used only by `/api/site/*`. It runs `apiKeyRateLimiter`, matches an enabled
`organization.api_key`, and sets `req.clerk_org_id` and
`req.auth_method = 'api_key'`. It resolves no property. A valid per-property
key gets `403 { error: "This endpoint requires an organization API key" }`;
anything else, a bearer token included, gets `401`.

## 3. Endpoints

### New: `src/routes/organization.js` (`authenticateOrg`)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/organization/properties` | any | `[{ id, name, slug, status }]` |
| POST | `/api/organization/properties` | admin | `{ name, slug? }`. `name` is required, trimmed, 1-100 chars, else `400`. `slug` uses the PUT /me rule and 409. `201` returns `{ id, name, slug, status, currency, timezone }`. Starter tokens are granted. |
| GET | `/api/organization/api-key` | admin | `{ api_key, api_key_enabled }` |
| POST | `/api/organization/api-key/rotate` | admin | new key |
| POST | `/api/organization/api-key/disable` | admin | |
| POST | `/api/organization/api-key/enable` | admin | |

All four api-key routes first run
`INSERT INTO organization (clerk_org_id, api_key) VALUES ($1, $2) ON CONFLICT (clerk_org_id) DO NOTHING`,
with a freshly generated key, so none of them depends on call order. Org keys
are `'org_' + crypto.randomBytes(32).toString('hex')`, mirroring
`generateApiKey`'s `prop_`.

### New: `src/routes/site.js` (`authenticateOrgKey`)

| Method | Path | Response |
|---|---|---|
| GET | `/api/site/properties` | `[{ id, name, slug, currency, timezone, websites: [url] }]`, covering active properties and active websites only |

There are no secrets in the response (`api_key`, Stripe, Vercel, Sidon
fields).

### Changed

- `PUT /api/property/me` accepts `slug`: either `^[a-z0-9-]{1,60}$` or `null`
  (clears it), else `400`. A clash within the org →
  `409 { error: "That slug is already used by another property in this organization" }`.
  The 23505 on `property_org_slug_key` is mapped here and in POST
  `/api/organization/properties`, never left to the generic 500.
- `GET /api/availability/search`: the inline key lookup is replaced by
  `resolveSiteProperty`, using the same headers. A key that resolves wins. A
  key that returns `{ status, error }` returns that error. Without a key, the
  public `?property_id=` fallback stays.
- `src/routes/mcp.js`: also forwards `X-Property-Id: req.property_id` (the
  already-resolved hotel) to its loopback client. That one line covers both
  rails: per-property keys ignore it, while bearer and org-key calls are
  pinned to the same hotel as the outer request.
- Swagger: new routes, the four headers, `slug`.

### Known limitation

When several hotels share one website build that is mapped to one Vercel
project, Vercel Web Analytics shows group totals for every hotel. GA4 is
already scoped by host (`getWebsiteAnalytics`), so it gives per-hotel figures.

## Out of scope

- Deleting or archiving a hotel. `status` already covers it, and step 3 above
  makes all-inactive safe.
- Moving a hotel between orgs.
- Cross-hotel reports and pooled org billing.
- Cross-hotel availability search: the group site calls
  `/api/availability/search` once per hotel with `X-Property-Slug`.
- Dashboard UI (separate repo) and website build changes (separate repo).

## 4. Rollout

1. Pre-flight: confirm `property_clerk_org_id_key` exists on the live DB
   (`SELECT conname FROM pg_constraint WHERE conrelid = 'property'::regclass AND contype = 'u'`).
2. Migration `multi-property-per-org` (additive). This is safe with the old
   code running.
3. OTA code, including the locked auto-create. While UNIQUE still exists, the
   lock simply makes the constraint unreachable.
4. Migration `property-org-not-unique`. Only now can an org own a second
   hotel.
5. Dashboard: hotel switcher + `X-Property-Id` (separate repo).
6. Website: org key + `X-Site-Host` / `X-Property-Slug` (separate repo).

Steps 5 and 6 are independent. Single-hotel orgs and per-property keys work
throughout.

## 5. Testing

`scripts/check-multi-property.js` is styled on `check-review-requests.js`: one
rolled-back transaction, it refuses remote DBs, and it calls
`resolveStaffProperty` / `resolveSiteProperty` directly with the transaction
client. The run's first step drops `property_clerk_org_id_key` inside the
transaction, so it works before migration 2.

Fixtures:
- **Org A**, with A1 (slug `seaview`, site `HTTPS://WWW.Seaview-Hotel.com/`,
  plus site `https://mygroup.com/seaview`) and A2 (slug `harbour`, site
  `https://mygroup.com/harbour`). Org A also has an inactive A3.
- **Org B**, with B1 (slug `seaview`, site `https://seaview-hotel.com`).
- **Org C**, with one hotel.
- **Org D**, with only an inactive hotel.

Asserts:

- **`hostKey`:** `HTTPS://WWW.X.com/a?b#c`, `x.com:8443`, `user:pw@x.com`,
  `X.COM.`, `bücher.de` → `xn--bcher-kva.de`, garbage → `null`.
- **Staff:**
  - org A, no header → 400; org C, no header → C's hotel
  - org A + A2's id → A2; org A + B1's id → 404; malformed id → 404; A3's id → 404
  - org D → 403, with no new row inserted
  - new org E → exactly one row, and a second resolve for E inserts nothing
- **Org key, org A:**
  - `X-Property-Id` A2 → A2
  - slug `harbour` → A2; slug `nope` → 404
  - host `seaview-hotel.com` and host `WWW.SEAVIEW-HOTEL.COM:443` → A1, not B1
    (B1 is in the other org)
  - host `mygroup.com` → 400 (it serves two hotels)
  - slug `harbour` + host `seaview-hotel.com` → A2 (the slug wins)
  - no selector → 400
- **Org key, other orgs:** org C, no selector → C's hotel; org key disabled →
  `null`.
- **Per-property key:** resolves to its own property even when it sends A2's
  slug or host.
- **Slug constraint:** the same slug in orgs A and B is allowed; a duplicate
  slug within org A → 23505 on `property_org_slug_key`.
