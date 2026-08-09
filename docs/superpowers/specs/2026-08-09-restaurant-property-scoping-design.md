# Restaurant module: property scoping (multi-property Phase 2)

## Context

The multi-property (multi-tenant) rollout landed its Phase 1 "core" scope
on `main`: `property`, `api_user`, `guest`, `room_type`, `room`,
`room_availability`, `booking`, `payment`, and `extra` all carry a
`property_id`, staff routes require a JWT (`authenticate`, which sets
`req.property_id`), and guest-facing writes use `authenticateOrApiKey`
(JWT **or** `X-Api-Key` + an explicit `property_id`). See
`docs/superpowers/specs/2026-07-12-multi-property-design.md` for the full
Phase 1 spec — this document follows the same conventions.

The restaurant module (`restaurant`, `restaurant_table`, `service_period`,
`restaurant_reservation`, `restaurant_seasonal_closure`) was explicitly out
of scope for Phase 1 and still has no `property_id` anywhere; every route
is gated by the old shared `X-Api-Key` (`requireApiKey`), and browse
endpoints (`GET /api/restaurant`, `GET /api/restaurant/:id`,
`GET /api/restaurant/:restaurant_id/tables`) have no gate at all. This is
Phase 2 of the rollout ("Restaurant"), per that document's phased plan.

Unlike Phase 1 (which had no production data and could reset the dev DB),
the restaurant module now holds real production data — 6 restaurants and
their tables/reservations — so this phase needs a non-destructive migration
with an explicit backfill, not a schema reset.

### Property backfill mapping (confirmed with the user)

| Restaurant | Property |
|---|---|
| Bonito | `Bonito` (`e1000000-0000-0000-0000-000000000003`) |
| Bimini | `Bonito` (`e1000000-0000-0000-0000-000000000003`) |
| Betula | `Bonito` (`e1000000-0000-0000-0000-000000000003`) |
| Barry | `Bonito` (`e1000000-0000-0000-0000-000000000003`) |
| BBYC | `BBYC` (`e1000000-0000-0000-0000-000000000004`) |
| Pirates Bight | `BBYC` (`e1000000-0000-0000-0000-000000000004`) |

## Goals

- Add `property_id UUID NOT NULL REFERENCES property(id)` directly to all
  5 restaurant tables (not just the root `restaurant` table), matching the
  Phase 1 pattern of avoiding parent-chain joins in every query.
- Staff-only access to restaurant management: list/get/create/update
  restaurants and tables, and list/get/update reservations, require
  `authenticate` (JWT) and are scoped to `req.property_id`.
- Guest-facing reservation creation keeps working via `X-Api-Key` — `POST
  /:restaurant_id/reservations` switches to `authenticateOrApiKey`,
  matching `createBooking`.
- `GET /:restaurant_id/availability/search` stays fully public and
  unauthenticated — it's already scoped tightly by `restaurant_id` in the
  URL, so there's no tenant-isolation gap to close there.
- Preserve all 6 existing restaurants and their tables/reservations via a
  backfill migration, using the mapping above.

## Non-goals (explicitly out of scope)

- No change to `guest`/`room`/etc. — this phase only touches the 5
  restaurant tables.
- No new `?property_id=` query-param public-browse mode — the user
  confirmed browse endpoints should require staff login, not stay public.
- No cross-property restaurant transfer tooling — the backfill is a
  one-time, one-way data fix.
- Spa/tours/golf/beach club/equipment/room service/pro shop stay on
  `requireApiKey`, unscoped — later phases per the Phase 1 plan's phased
  rollout list.

## Data model

```sql
ALTER TABLE restaurant                 ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_table           ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE service_period             ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_reservation     ADD COLUMN property_id UUID REFERENCES property(id);
ALTER TABLE restaurant_seasonal_closure ADD COLUMN property_id UUID REFERENCES property(id);
```

Added nullable first (see Migration below for the backfill + `SET NOT
NULL` sequence). `schema.sql` itself is updated in place to declare the
column `NOT NULL` directly, for fresh installs that never carry legacy
data.

Indexes: a plain `idx_<table>_property ON <table>(property_id)` for each
of the 5 tables.

No unique-constraint changes — `restaurant_table(restaurant_id,
table_number)` and the rest are already scoped transitively through
`restaurant_id`/`table_id`, which are themselves now single-property.

## API & behavior

Routes (no path changes, only middleware and query scoping):

```
GET    /api/restaurant                        authenticate, scoped to req.property_id
GET    /api/restaurant/:id                    authenticate, scoped
POST   /api/restaurant                        authenticate (was requireApiKey)
PUT    /api/restaurant/:id                    authenticate, scoped

GET    /api/restaurant/:restaurant_id/tables       authenticate, scoped
POST   /api/restaurant/:restaurant_id/tables       authenticate (was requireApiKey)
PUT    /api/restaurant/:restaurant_id/tables/:id   authenticate, scoped

GET    /api/restaurant/:restaurant_id/availability/search   unchanged — public, no auth

GET    /api/restaurant/:restaurant_id/reservations       authenticate, scoped
GET    /api/restaurant/:restaurant_id/reservations/:id   authenticate, scoped
POST   /api/restaurant/:restaurant_id/reservations        authenticateOrApiKey (was requireApiKey)
PUT    /api/restaurant/:restaurant_id/reservations/:id    authenticate, scoped
```

Controller query changes, mirroring `extras.js`/`bookings.js`:

- `listRestaurants`: add `AND property_id = $1`.
- `getRestaurant`/`updateRestaurant`: add `AND property_id = $n` to the
  `WHERE`.
- `createRestaurant`: insert `property_id` from `req.property_id`; any
  `property_id` in the body is ignored.
- `listTables`/`createTable`/`updateTable`: same shape, scoped via the
  table's own `property_id` column (not a join through `restaurant`).
- `searchAvailability`: unchanged — still resolves purely from
  `restaurant_id` in the URL, no `property_id` involved (route stays
  public).
- `listReservations`/`getReservation`/`updateReservation`: add `AND
  rr.property_id = $n` directly — `restaurant_reservation` carries its own
  `property_id` column, so no join through `restaurant_table` is needed
  for this check.
- `createReservation`: the existing restaurant-lookup (`WHERE id = $1 AND
  status = 'active'`) gains `AND property_id = $2` using
  `req.property_id` from `authenticateOrApiKey` — a `restaurant_id` from
  another property now 404s, same as a made-up id. Insert sets
  `restaurant_reservation.property_id` from `req.property_id`. If
  `guest_id` is supplied, it's checked against `req.property_id` the same
  way `createBooking` checks guest ownership (`SELECT id FROM guest WHERE
  id = $1 AND property_id = $2`) — a cross-property guest id now 404s
  instead of silently attaching.

Foreign/cross-property IDs return `404` everywhere, never `403` — same
rule as Phase 1, never confirm another tenant's row exists.

`src/docs/swagger.js` gets updated to note the new auth requirement on
these paths (staff bearer token vs. API key), matching how other
`authenticate`/`authenticateOrApiKey` routes are already documented.

## Migration & rollout

Following this project's non-destructive migration convention (see
`migrate-2026-08-08-restaurant-status.sql`):

- `schema.sql` is updated in place — `property_id UUID NOT NULL
  REFERENCES property(id)` added directly to all 5 table definitions, plus
  the 5 new indexes — so a fresh full reset produces the final shape
  directly.
- New `migrate-2026-08-09-restaurant-property-scoping.sql` for the
  already-populated dev/prod databases:
  1. Add each `property_id` column **nullable** (`ADD COLUMN IF NOT
     EXISTS property_id UUID REFERENCES property(id)`).
  2. Backfill `restaurant.property_id` directly by name, per the mapping
     table above.
  3. Backfill `restaurant_table`, `service_period`,
     `restaurant_reservation`, `restaurant_seasonal_closure` by joining
     back to `restaurant.id` (`UPDATE ... SET property_id = r.property_id
     FROM restaurant r WHERE r.id = <table>.restaurant_id`, and for
     `restaurant_reservation` via `restaurant_table` since it links
     through `table_id`, not `restaurant_id` directly).
  4. `ALTER COLUMN property_id SET NOT NULL` on all 5 tables, once
     backfilled.
  5. Create the 5 indexes.
  Idempotent-safe via `IF NOT EXISTS` on the column adds and indexes; the
  `UPDATE`/backfill steps are naturally idempotent (re-running them is a
  no-op once every row already has the correct value).
- The 3 restaurant seed files (`seed-restaurant-bonito.sql`,
  `seed-restaurant-bimini-betula-barry.sql`,
  `seed-restaurant-pirates-bight.sql`) are updated to insert the correct
  `property_id` per the mapping table, so a future fresh-reset local setup
  produces correctly scoped rows without relying on the migration's
  backfill logic.
- Migration is run against local first (verify), then production —
  same two-step process used for `restaurant-status`.

## Testing approach

No automated test framework in this project — manual checks (`curl`
against a running `npm run dev`, using a Bonito-property staff JWT and a
BBYC-property staff JWT):

1. Run the migration locally. Confirm all 6 restaurants have the correct
   `property_id` per the mapping table, and all 5 tables reject a `NULL`
   insert (`NOT NULL` constraint active).
2. `GET /api/restaurant` with no auth → `401`. With a Bonito-property
   staff token → the 4 Bonito restaurants only (Bonito, Bimini, Betula,
   Barry), not BBYC or Pirates Bight.
3. `GET /api/restaurant/:id` for a BBYC restaurant, using the Bonito
   token → `404` (cross-property access, not `403`).
4. `POST /api/restaurant/:restaurant_id/reservations` with `X-Api-Key` +
   `property_id` in the body, against a restaurant from a *different*
   property than the one supplied → `404`. Against a matching
   restaurant/property pair → `201`, and the created row's
   `property_id` matches.
5. `POST ... /reservations` with a `guest_id` belonging to a different
   property than the target restaurant → `404`.
6. `GET /api/restaurant/:restaurant_id/reservations` with a staff token →
   only that property's reservations.
7. `GET /:restaurant_id/availability/search` with no auth at all → still
   works unchanged (`200`), confirming the public search path wasn't
   accidentally gated.
