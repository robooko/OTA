# Equipment module: property scoping

## Context

Every other guest-facing/catalogue module (restaurant, tours, spa, golf,
pro shop) has already been scoped to `property_id` and switched from the
old shared `X-Api-Key` (`requireApiKey`) to `authenticate` (Clerk).
Equipment (`equipment`, `equipment_hire`) is the last one still on the
old model: `equipment` and `equipment_hire` have **no `property_id`
column at all**, `GET /` and `GET /search` are fully public (no auth
gate), and every write/hire route is still `requireApiKey`-only —
unreachable from `ota-table-bookings`, which only ever sends a Clerk
bearer token. This is why `/equipment` in that repo is still a "Coming
soon" stub.

Like tours/golf/pro-shop before this, there is **no existing equipment
data** — confirmed empty (`equipment`, `equipment_hire`) on both local
and live databases. This removes the backfill-mapping problem the
restaurant/spa phases had to solve; the migration here is a
straightforward additive `NOT NULL` column add on both tables.

## Goals

- Add `property_id UUID NOT NULL REFERENCES property(id)` to both
  `equipment` and `equipment_hire`.
- Staff-only access to the full module: list/create/update equipment,
  search availability, and list/create/update hires all require
  `authenticate` (Clerk) and are scoped to `req.property_id`.
- `createHire`'s availability check (equipment lookup + already-hired
  sum) is additionally scoped so a `quantity` decision can never be
  made against another property's inventory or hires.

## Non-goals

- No backfill migration — there is no existing equipment or hire data
  to preserve.
- No public/unauthenticated browse mode for `GET /` or `GET /search` —
  confirmed with the user: staff login required, same decision already
  made identically for restaurant/tours/spa/golf/pro-shop.
- No guest-facing/API-key path (`authenticateOrApiKey`) for any
  equipment route — the companion frontend spec
  (`docs/superpowers/specs/2026-08-16-equipment-hire-pages-design.md`
  in `ota-table-bookings`) is a staff admin page, not a guest booking
  widget. If a guest-facing hire flow is wanted later, that's a
  separate decision requiring its own pass (mirroring how every
  guest-facing endpoint elsewhere was an explicit, individually
  confirmed choice).
- No UI or backend change for the `golf_booking_id` link on
  `equipment_hire` beyond what already exists (the column and the API
  already accept it) — no picker UI in this pass, matching how pro
  shop items attaching to golf bookings was deferred.
- No change to any other module.

## Data model

```sql
ALTER TABLE equipment      ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE equipment_hire ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
```

Added `NOT NULL` directly — valid in Postgres on tables with zero
existing rows, no `DEFAULT` needed. `schema.sql` is updated in place to
declare both columns this way from the start.

Indexes: `idx_equipment_property`, `idx_equipment_hire_property`.

## API & behavior

Routes (no path changes, only middleware and query scoping):

```
GET    /api/equipment              authenticate, scoped to req.property_id (was public, no auth)
POST   /api/equipment              authenticate (was requireApiKey)
PUT    /api/equipment/:id          authenticate, scoped

GET    /api/equipment/search       authenticate, scoped (was public, no auth)

GET    /api/equipment/hires        authenticate, scoped, gains ?equipment_id= filter (was requireApiKey)
POST   /api/equipment/hires        authenticate, scoped (was requireApiKey)
PUT    /api/equipment/hires/:id    authenticate, scoped (was requireApiKey)
```

Controller changes:

- `listEquipment`: add `AND property_id = $n` (appended after the
  existing optional `type` filter).
- `createEquipment`: insert `property_id` from `req.property_id`.
- `updateEquipment`: add `AND property_id = $n` to the `WHERE`.
- `searchEquipment`: add `AND e.property_id = $n` to the base `WHERE`
  (before the `GROUP BY`); the `LEFT JOIN` on `equipment_hire` also
  gains `AND eh.property_id = $n` so the availability subtraction can
  never sum another property's hires against this property's stock —
  defensively redundant with the FK-implied scoping (a hire can only
  reference equipment via `equipment_id`, and equipment is now
  property-scoped) but matches this codebase's established pattern of
  scoping every side of a join explicitly (e.g. `golf_booking_item`).
- `listHires`: add `AND eh.property_id = $n` to the `WHERE 1=1` chain,
  and add a new optional `equipment_id` filter alongside the existing
  `date`/`status`/`guest_id`/`golf_booking_id` ones (same
  `if (x) { params.push(x); query += ... }` shape) — this is a genuine
  column on `equipment_hire`, unlike golf's `course_id`-on-bookings gap
  that forces `golf-bookings-client.ts` to filter client-side by name
  match; the companion frontend spec's per-equipment "Hires" link
  depends on this filter existing server-side.
- `createHire`: every step of the transaction gains a property check —
  the `equipment` lookup (`SELECT * FROM equipment WHERE id = $1`)
  gains `AND property_id = $2`, so a foreign `equipment_id` 404s
  instead of silently succeeding; the already-hired sum
  (`SELECT COALESCE(SUM(quantity)...)`) gains `AND property_id = $n`,
  matching the join-scoping reasoning above; the `INSERT` sets
  `equipment_hire.property_id` from `req.property_id`.
- `updateHire`: add `AND property_id = $n` to the `WHERE`.

Foreign/cross-property IDs return `404` everywhere, never `403` — same
rule as every prior phase.

`src/docs/swagger.js` gets updated to reflect the new auth requirement
on each path (add `security: [{ bearerAuth: [] }]` to `GET /` and
`GET /search`, which currently have no `security` key at all), and
`GET /api/equipment/hires`'s parameters gain the new
`equipment_id` (`string`, `format: uuid`) entry.

## Migration & rollout

No backfill needed (zero existing rows in both tables, confirmed on
both local and live). One migration file, run against local then live:

```sql
ALTER TABLE equipment      ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE equipment_hire ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_equipment_property      ON equipment(property_id);
CREATE INDEX IF NOT EXISTS idx_equipment_hire_property ON equipment_hire(property_id);
```

Idempotent-safe via `IF NOT EXISTS`. `schema.sql` updated in place so a
fresh full reset produces the final shape directly.

## Testing approach

No automated test framework — manual checks (`curl` against a running
`npm start`, using two different properties' staff tokens):

1. Run the migration locally. Confirm `equipment`/`equipment_hire` both
   have `property_id` and reject a direct `NULL` insert.
2. `GET /api/equipment` with no auth → `401` (previously public). With
   Robs's staff token → only Robs's equipment.
3. `GET /api/equipment/search?date=...` with no auth → `401`
   (previously public).
4. `POST /api/equipment` with Robs's token → `201`, `property_id`
   matches Robs. With the old shared `API_KEY` → `401` (confirms full
   replacement, not additive).
5. `PUT /api/equipment/:id` for equipment belonging to a different
   property → `404`.
6. Create equipment under Robs and equipment under a different property
   directly via SQL (e.g. BBYC). `POST /api/equipment/hires` with
   Robs's token for Robs's own equipment → `201`, correct `total_price`.
   For the foreign equipment's id → `404`.
7. `GET /api/equipment/hires?date=...` — confirm it only returns Robs's
   hires, not the foreign property's, even for the same date.
8. `POST /api/equipment/hires` with a `quantity` exceeding what's
   actually available for Robs's own equipment on that date → `409`,
   confirming the availability math still works correctly once scoped.
9. `PUT /api/equipment/hires/:id` for a hire belonging to a different
   property → `404`.
10. Repeat the core checks (2, 4, 6, 8) against live once local passes.
