# Pro Shop module: property scoping

## Context

The restaurant module was scoped to `property_id` in
`docs/superpowers/specs/2026-08-09-restaurant-property-scoping-design.md`;
tours, spa, and golf followed the same pattern (`2026-08-10-tours-...`,
`2026-08-11-spa-...`, `2026-08-15-golf-property-scoping-design.md`). Pro
Shop (`proshop_item`, plus the `golf_booking_item` linkage table) is
next — `proshop_item` has no `property_id` anywhere, `GET
/api/proshop/items` has no auth gate at all, and every write route is
still gated by the old shared `X-Api-Key` (`requireApiKey`). This is a
prerequisite for the `ota-table-bookings` frontend's new `/pro-shop`
page (`docs/superpowers/specs/2026-08-16-shop-page-design.md` in that
repo), which only ever sends a Clerk bearer token.

`golf_booking_item` already has `property_id` — added in the golf
property-scoping migration alongside `golf_course`/`tee_time`/
`golf_booking`, since it's read (via `LEFT JOIN`) inside `listBookings`.
Its 3 dedicated routes (`GET/POST /booking/:booking_id`, `DELETE
/booking/:booking_id/:id`) were left on `requireApiKey`, unscoped, at
the time — this phase finishes that by scoping them too, even though
the frontend won't have UI for them yet (per the accompanying frontend
spec's scope decision, item-booking attachment is a later follow-up).
Finishing the whole module in one pass, the way `golf.js` itself was
fully scoped even though tee-time individual-edit isn't used by any
frontend yet either, avoids a second backend pass when that follow-up
lands.

Like tours and golf, there is **no existing pro shop data** — confirmed
empty (`proshop_item`, `golf_booking_item`) on both local and live
databases. This removes the backfill-mapping problem the restaurant/
spa phases had to solve; the migration here is a straightforward
additive `NOT NULL` column add.

## Goals

- Add `property_id UUID NOT NULL REFERENCES property(id)` directly to
  `proshop_item`.
- Staff-only access to the full module: list/create/update catalogue
  items, and list/add/remove items on a golf booking, all require
  `authenticate` (Clerk) and are scoped to `req.property_id`.
- `addBookingItem`/`removeBookingItem` additionally verify the target
  `golf_booking` belongs to `req.property_id` before acting — today
  `addBookingItem` only checks the booking exists at all (`SELECT id
  FROM golf_booking WHERE id = $1`, no property check), and
  `removeBookingItem` has no ownership check beyond `booking_id`
  matching in the `DELETE`'s `WHERE`.

## Non-goals

- No backfill migration or mapping table — there is no existing pro
  shop data to preserve.
- No public/unauthenticated browse mode for `GET /items` — confirmed
  with the user: staff login required, same decision already made
  identically for restaurant/tours/spa/golf.
- No guest-facing/API-key path for any pro shop route — unlike
  `createBooking`-style endpoints elsewhere, nothing here is guest-
  initiated (items are attached to an *existing* golf booking by
  staff, not created by a guest), so there's no `authenticateOrApiKey`
  case in this module at all, unlike every other phase.
- No frontend wiring for the `golf_booking_item` routes — the Shop
  page (this session's companion frontend spec) only builds the
  catalogue UI. Booking-item attachment UI is a later follow-up.
- No change to any other module.

## Data model

```sql
ALTER TABLE proshop_item ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
```

Added `NOT NULL` directly — valid in Postgres on a table with zero
existing rows, no `DEFAULT` needed. `schema.sql` is updated in place to
declare the column this way from the start.

Index: `idx_proshop_item_property`.

`golf_booking_item` already has `property_id` (`NOT NULL`, indexed) —
no data-model change needed for it in this phase.

## API & behavior

Routes (no path changes, only middleware and query scoping):

```
GET    /api/proshop/items                    authenticate, scoped to req.property_id (was public, no auth)
POST   /api/proshop/items                     authenticate (was requireApiKey)
PUT    /api/proshop/items/:id                 authenticate, scoped

GET    /api/proshop/booking/:booking_id       authenticate, scoped (was requireApiKey)
POST   /api/proshop/booking/:booking_id       authenticate, scoped (was requireApiKey)
DELETE /api/proshop/booking/:booking_id/:id   authenticate, scoped (was requireApiKey)
```

Controller changes:

- `listItems`: add `AND property_id = $n` (appended after the existing
  optional `category` filter, since that filter's own `$n` position is
  conditional).
- `createItem`: insert `property_id` from `req.property_id`.
- `updateItem`: add `AND property_id = $n` to the `WHERE`.
- `listBookingItems`: add `AND gbi.property_id = $n` to the `WHERE`
  (currently filters only on `booking_id`).
- `addBookingItem`: the `golf_booking` existence check
  (`SELECT id FROM golf_booking WHERE id = $1`) gains
  `AND property_id = $2` using `req.property_id` — a `booking_id` from
  another property now `404`s instead of silently succeeding. The
  `proshop_item` lookup (`SELECT * FROM proshop_item WHERE id = $1 AND
  status = 'active'`) also gains `AND property_id = $2` — an item from
  another property is invisible, same as a made-up id. Insert sets
  `golf_booking_item.property_id` from `req.property_id`.
- `removeBookingItem`: add `AND property_id = $n` to the `DELETE`'s
  `WHERE` (currently checks `id` and `booking_id` but not property).

Foreign/cross-property IDs return `404` everywhere, never `403` — same
rule as every prior phase.

`src/docs/swagger.js` gets updated to reflect the new auth requirement
on each path and to drop `security: []`/absent-security from the
previously-public `GET /items`.

## Migration & rollout

No backfill needed (zero existing rows in `proshop_item`, confirmed on
both local and live). One migration file, run against local then live:

```sql
ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_property ON proshop_item(property_id);
```

Idempotent-safe via `IF NOT EXISTS`. `schema.sql` updated in place so a
fresh full reset produces the final shape directly.

## Testing approach

No automated test framework — manual checks (`curl` against a running
`npm run dev`, using two different properties' staff tokens):

1. Run the migration locally. Confirm `proshop_item` has the
   `property_id` column and rejects a direct `NULL` insert.
2. `GET /api/proshop/items` with no auth → `401` (previously public).
   With Robs's staff token → only Robs's items.
3. `POST /api/proshop/items` with Robs's token → `201`, `property_id`
   matches Robs. With the old shared `API_KEY` → `401` (confirms full
   replacement, not additive).
4. `PUT /api/proshop/items/:id` for an item belonging to a different
   property → `404`.
5. Create a golf course/tee-time/booking under Robs (reusing the golf
   module, already scoped) and a "foreign" one directly via SQL under
   a different property (e.g. BBYC). `POST /api/proshop/booking/:id`
   with Robs's token for Robs's booking + a Robs item → `201`. For the
   foreign booking → `404`. For a foreign item against Robs's own
   booking → `404`.
6. `GET /api/proshop/booking/:booking_id` for a foreign booking →
   `200`, empty array — `listBookingItems` filters by `property_id`
   but (matching this codebase's convention for list-style GETs, e.g.
   golf's `searchTeeTimes`) has no explicit booking-existence check,
   so a real-but-foreign `booking_id` simply matches no rows rather
   than 404ing. Was reachable via any `X-Api-Key` before regardless.
7. `DELETE /api/proshop/booking/:booking_id/:id` where `booking_id`
   and `id` both correctly match a real row but the row belongs to a
   different property → `404` (isolates the new `property_id` check
   specifically, distinct from the pre-existing `booking_id` mismatch
   case, which already 404'd before this phase). For Robs's own →
   `204`.
8. Repeat the core checks (2, 3, 5) against live once local passes.
