# Golf module: property scoping

## Context

The restaurant module was scoped to `property_id` in
`docs/superpowers/specs/2026-08-09-restaurant-property-scoping-design.md`;
tours and spa followed the same pattern
(`2026-08-10-tours-property-scoping-design.md`,
`2026-08-11-spa-property-scoping-design.md`). Golf (`golf_course`,
`tee_time`, `golf_booking`, `golf_booking_item`) is next — it still has
no `property_id` anywhere, every management route is gated by the old
shared `X-Api-Key` (`requireApiKey`), and `GET /api/golf/courses` /
`GET /api/golf/tee-times/search` have no gate at all: every course and
tee time is visible and bookable regardless of property. This is a
prerequisite for the `ota-table-bookings` frontend's new `/golf` and
`/golf-bookings` pages
(`docs/superpowers/specs/2026-08-15-golf-page-design.md` in that repo),
which only ever send a Clerk bearer token and cannot reach any route
still gated by `requireApiKey`.

Like tours, there is **no existing golf data** — confirmed empty
(`golf_course`, `tee_time`, `golf_booking`, `golf_booking_item`) on
both local and live databases. This removes the backfill-mapping
problem the restaurant/spa phases had to solve; the migration here is
a straightforward additive `NOT NULL` column add.

## Goals

- Add `property_id UUID NOT NULL REFERENCES property(id)` directly to
  all 4 golf tables (`golf_course`, `tee_time`, `golf_booking`,
  `golf_booking_item`), matching the established "avoid parent-chain
  joins in every query" pattern.
- Staff-only access to golf management and browsing: list/create/update
  courses, bulk-create/search tee times, and list/create/update
  bookings all require `authenticate` (Clerk) and are scoped to
  `req.property_id`.
- Guest-facing booking creation keeps working via `X-Api-Key`:
  `POST /api/golf/bookings` switches to `authenticateOrApiKey`,
  matching `createBooking` (tours)/`createReservation`/`createAppointment` (spa).
- Extend `updateBooking` to also accept `contact_name`, `contact_email`,
  `contact_phone` (currently only `status`/`notes`), matching
  `updateReservation`'s field set — needed for the frontend's full
  booking-edit UI. `tee_time_id` and `players` stay immutable after
  creation, same as reservations' party size/table.

## Non-goals

- No backfill migration or mapping table — there is no existing golf
  data to preserve.
- No public/unauthenticated browse mode for `GET /courses` or
  `GET /tee-times/search` — confirmed with the user: both require staff
  login, same decision already made for restaurant/tours/spa.
- No change to `golf_booking_item` write endpoints — there are none
  today (items are only ever inserted as part of a future pro-shop
  integration, not this pass). It's already read inside `listBookings`
  (`LEFT JOIN golf_booking_item gbi ON gbi.booking_id = gb.id`), but
  needs no explicit `property_id` filter there — it's transitively
  scoped through the outer `gb.property_id = $n` check on
  `golf_booking`. Adding the column now (rather than deferring it) just
  keeps it consistent with every other golf table ahead of whichever
  future pass adds item-management endpoints.
- No change to any other module — beach club/equipment/room
  service/pro shop stay on `requireApiKey`, unscoped — later phases,
  not this one.

## Data model

```sql
ALTER TABLE golf_course       ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tee_time          ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking      ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking_item ADD COLUMN property_id UUID NOT NULL REFERENCES property(id);
```

Added `NOT NULL` directly — valid in Postgres on tables with zero
existing rows, no `DEFAULT` needed. `schema.sql` is updated in place to
declare the column this way from the start.

Indexes: `idx_golf_course_property`, `idx_tee_time_property`,
`idx_golf_booking_property`, `idx_golf_booking_item_property` — one per
table.

No unique-constraint changes — `tee_time`'s existing
`UNIQUE (course_id, tee_date, tee_time)` is already scoped transitively
through `course_id`, which is itself now single-property.

## API & behavior

Routes (no path changes, only middleware and query scoping):

```
GET    /api/golf/courses              authenticate, scoped to req.property_id (was public, no auth)
POST   /api/golf/courses              authenticate (was requireApiKey)
PUT    /api/golf/courses/:id          authenticate, scoped

POST   /api/golf/tee-times/bulk       authenticate (was requireApiKey)
GET    /api/golf/tee-times/search     authenticate, scoped (was public, no auth)

GET    /api/golf/bookings             authenticate, scoped (was requireApiKey)
POST   /api/golf/bookings             authenticateOrApiKey (was requireApiKey)
PUT    /api/golf/bookings/:id         authenticate, scoped (was requireApiKey)
```

Controller changes:

- `listCourses`: add `AND property_id = $1`.
- `createCourse`: insert `property_id` from `req.property_id`.
- `updateCourse`: add `AND property_id = $n` to the `WHERE`.
- `bulkCreateTeeTimes`: first verify `course_id` belongs to
  `req.property_id` (`SELECT id FROM golf_course WHERE id = $1 AND
  property_id = $2`) — `404` if not, same as a made-up id. Each
  inserted `tee_time` row sets `property_id = req.property_id` directly
  (not derived via a join at query time later).
- `searchTeeTimes`: add `AND tt.property_id = $n` — scope directly on
  `tee_time`'s own new column rather than through the existing
  `golf_course` join, so the check doesn't depend on the join shape.
- `listBookings`: add `AND gb.property_id = $n` directly —
  `golf_booking` carries its own `property_id`, no join through
  `tee_time`/`golf_course` needed for this check.
- `createBooking`: the tee-time lookup (`WHERE tt.id = $1`) gains
  `AND tt.property_id = $2` using `req.property_id` — a `tee_time_id`
  from another property now `404`s instead of silently succeeding.
  Insert sets `golf_booking.property_id` from `req.property_id`. If
  `guest_id` is supplied, it's checked against `req.property_id` the
  same way `createReservation`/tours'/spa's booking creation checks
  guest ownership — a cross-property guest id now `404`s instead of
  silently attaching.
- `updateBooking`: add `AND property_id = $n` to the `WHERE`, and accept
  `contact_name`/`contact_email`/`contact_phone` in the `SET` clause
  alongside the existing `status`/`notes` (see Goals).

Foreign/cross-property IDs return `404` everywhere, never `403` — same
rule as every prior phase, never confirm another tenant's row exists.

`src/docs/swagger.js` gets updated to reflect the new auth requirement
on each path (staff bearer token vs. API key, matching how other
`authenticate`/`authenticateOrApiKey` routes are already documented)
and to drop `security: []`/absent-security from the previously-public
`GET /courses` and `GET /tee-times/search`.

## Migration & rollout

No backfill needed (zero existing rows in `golf_course`/`tee_time`/
`golf_booking`/`golf_booking_item`, confirmed on both local and live).
One migration file, run against local then live:

```sql
ALTER TABLE golf_course       ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE tee_time          ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking      ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
ALTER TABLE golf_booking_item ADD COLUMN IF NOT EXISTS property_id UUID NOT NULL REFERENCES property(id);
CREATE INDEX IF NOT EXISTS idx_golf_course_property       ON golf_course(property_id);
CREATE INDEX IF NOT EXISTS idx_tee_time_property          ON tee_time(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_property      ON golf_booking(property_id);
CREATE INDEX IF NOT EXISTS idx_golf_booking_item_property ON golf_booking_item(property_id);
```

Idempotent-safe via `IF NOT EXISTS` throughout. `schema.sql` updated in
place so a fresh full reset produces the final shape directly.

## Testing approach

No automated test framework in this project — manual checks (`curl`
against a running `npm run dev`, using two different properties' staff
tokens, e.g. Robs and a second property):

1. Run the migration locally. Confirm all 4 tables have the
   `property_id` column and reject a direct `NULL` insert (`NOT NULL`
   active).
2. `GET /api/golf/courses` with no auth → `401` (previously public —
   confirms the auth requirement actually landed). With Robs's staff
   token → only Robs's courses.
3. `POST /api/golf/courses` with Robs's token → `201`, `property_id`
   matches Robs. With the old shared `API_KEY` (`X-Api-Key`, no bearer
   token) → `401` (confirms full replacement of `requireApiKey`, not
   additive).
4. `POST /api/golf/tee-times/bulk` for a course belonging to a
   *different* property than the caller's token → `404`.
5. `GET /api/golf/tee-times/search` with no auth → `401` (previously
   public). With a staff token → only that property's tee times.
6. `POST /api/golf/bookings` via `X-Api-Key` for a `tee_time_id`
   belonging to a different property's key → `404`. Via the matching
   property's key → `201`, `property_id` matches.
7. `POST /api/golf/bookings` with a `guest_id` belonging to a different
   property than the target tee time → `404`.
8. `GET /api/golf/bookings` with a staff token → only that property's
   bookings, not another property's.
9. `PUT /api/golf/bookings/:id` updating `contact_name`/`contact_email`/
   `contact_phone` → fields persist; a cross-property booking id → `404`.
10. Repeat the core checks (2, 3, 6) against live once local passes.
