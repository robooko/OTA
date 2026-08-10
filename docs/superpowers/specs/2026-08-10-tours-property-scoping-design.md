# Tours module: property scoping

## Context

The restaurant module was scoped to `property_id` in `docs/superpowers/specs/2026-08-09-restaurant-property-scoping-design.md` ("Phase 2" of the multi-property rollout, following the Phase 1 core scope on `main`). Tours (`tour`, `tour_slot`, `tour_booking`) was one of the modules explicitly left for a later phase — it still has no `property_id` anywhere, every management route is gated by the old shared `X-Api-Key` (`requireApiKey`), and `GET /api/tours` / `GET /api/tours/slots/search` have no gate at all: every tour is visible and bookable regardless of which property's context a caller is in.

Unlike the restaurant phase, there is **no existing tour data** — confirmed empty on both local and live databases. This removes the backfill-mapping problem that phase had to solve; the migration here is a straightforward additive `NOT NULL` column add.

## Goals

- Add `property_id UUID NOT NULL REFERENCES property(id)` directly to all 3 tour tables (`tour`, `tour_slot`, `tour_booking`), matching the restaurant phase's "avoid parent-chain joins in every query" pattern.
- Staff-only access to tour management and browsing: list/create/update tours, bulk-create slots, search slots, and list/update bookings all require `authenticate` (Clerk) and are scoped to `req.property_id`.
- Guest-facing booking creation keeps working via `X-Api-Key`: `POST /api/tours/bookings` switches to `authenticateOrApiKey`, matching `createBooking`/`createReservation`.

## Non-goals

- No backfill migration or mapping table — there is no existing tour data to preserve.
- No public/unauthenticated browse mode for `GET /` or `GET /slots/search` — confirmed with the user: both require staff login, same decision already made for the restaurant module's `GET /api/restaurant`.
- No change to any other module — this phase only touches the 3 tour tables.
- Golf/spa/beach club/equipment/room service/pro shop stay on `requireApiKey`, unscoped — later phases, not this one.

## Data model

```sql
ALTER TABLE tour         ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_slot    ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_booking ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
```

Added `NOT NULL` directly — valid in Postgres on a table with zero existing rows and no `DEFAULT` needed, since there's nothing to backfill. `schema.sql` is updated in place to declare the column this way from the start.

Indexes: `idx_tour_property`, `idx_tour_slot_property`, `idx_tour_booking_property`, one per table.

No unique-constraint changes — `tour_slot`'s existing `UNIQUE (tour_id, slot_date, slot_time)` is already scoped transitively through `tour_id`, which is itself now single-property.

## API & behavior

Routes (no path changes, only middleware and query scoping):

```
GET    /api/tours                authenticate, scoped to req.property_id
POST   /api/tours                authenticate (was requireApiKey)
PUT    /api/tours/:id            authenticate, scoped

POST   /api/tours/slots/bulk     authenticate (was requireApiKey)
GET    /api/tours/slots/search   authenticate, scoped to req.property_id (was public, no auth)

GET    /api/tours/bookings       authenticate, scoped
POST   /api/tours/bookings       authenticateOrApiKey (was requireApiKey)
PUT    /api/tours/bookings/:id   authenticate, scoped
```

Controller changes:

- `listTours`: add `AND property_id = $1`.
- `createTour`: insert `property_id` from `req.property_id`; any `property_id` in the body is ignored.
- `updateTour`: add `AND property_id = $n` to the `WHERE`.
- `bulkCreateSlots`: first verify `tour_id` belongs to `req.property_id` (`SELECT id FROM tour WHERE id = $1 AND property_id = $2`) — `404` if not, same as a made-up id. Each inserted `tour_slot` row sets `property_id = req.property_id` directly (not derived via a join at query time later).
- `searchSlots`: add `AND ts.property_id = $n` (or join-free, since `tour_slot` now carries its own `property_id`).
- `listBookings`: add `AND tb.property_id = $n` directly — `tour_booking` carries its own `property_id`, no join through `tour_slot`/`tour` needed for this check.
- `createBooking`: the slot lookup (`WHERE ts.id = $1`) gains `AND ts.property_id = $2` using `req.property_id` from `authenticateOrApiKey` — a `slot_id` from another property now `404`s instead of silently succeeding. Insert sets `tour_booking.property_id` from `req.property_id`. If `guest_id` is supplied, it's checked against `req.property_id` the same way `createReservation` checks guest ownership (`SELECT id FROM guest WHERE id = $1 AND property_id = $2`) — a cross-property guest id now `404`s instead of silently attaching.
- `updateBooking`: add `AND property_id = $n` to the `WHERE`.

Foreign/cross-property IDs return `404` everywhere, never `403` — same rule as every prior phase, never confirm another tenant's row exists.

`src/docs/swagger.js` gets updated to reflect the new auth requirement on each path (staff bearer token vs. API key, matching how other `authenticate`/`authenticateOrApiKey` routes are already documented) and to drop `security: []` from `GET /slots/search` now that it requires auth.

## Migration & rollout

No backfill needed (zero existing rows in `tour`/`tour_slot`/`tour_booking`, confirmed on both local and live). One migration file, run against local then live:

```sql
ALTER TABLE tour         ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_slot    ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tour_booking ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_tour_property         ON tour(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_slot_property     ON tour_slot(property_id);
CREATE INDEX IF NOT EXISTS idx_tour_booking_property  ON tour_booking(property_id);
```

Idempotent-safe via `IF NOT EXISTS` throughout. `schema.sql` updated in place so a fresh full reset produces the final shape directly.

## Testing approach

No automated test framework in this project — manual checks (`curl` against a running `npm run dev`, using two different properties' staff tokens, e.g. Robs and a second property):

1. Run the migration locally. Confirm all 3 tables have the `property_id` column and reject a direct `NULL` insert (`NOT NULL` active).
2. `GET /api/tours` with no auth → `401` (previously public — confirms the auth requirement actually landed). With Robs's staff token → only Robs's tours.
3. `POST /api/tours` with Robs's token → `201`, `property_id` matches Robs. With the old shared `API_KEY` (`X-Api-Key`, no bearer token) → `401` (confirms full replacement of `requireApiKey`, not additive).
4. `POST /api/tours/slots/bulk` for a tour belonging to a *different* property than the caller's token → `404`.
5. `GET /api/tours/slots/search` with no auth → `401` (previously public). With a staff token → only that property's slots.
6. `POST /api/tours/bookings` via `X-Api-Key` for a `slot_id` belonging to a different property's key → `404`. Via the matching property's key → `201`, `property_id` matches.
7. `POST /api/tours/bookings` with a `guest_id` belonging to a different property than the target slot → `404`.
8. `GET /api/tours/bookings` with a staff token → only that property's bookings, not another property's.
9. Repeat the core checks (2, 3, 6) against live once local passes.
