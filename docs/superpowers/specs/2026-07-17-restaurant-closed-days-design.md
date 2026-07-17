# Restaurant closed days

## Context

The restaurant module (`restaurant`, `restaurant_table`, `restaurant_reservation`)
models a single continuous service window per restaurant
(`service_start`/`service_end`/`slot_interval_minutes`/`default_duration_minutes`),
computing availability on demand from table capacity + existing reservations
(see `2026-07-15-restaurant-availability-redesign-design.md`). That redesign
explicitly called out "day-of-week variation in service hours" as a
non-goal. Bonito needs exactly this now: it's closed on Sundays, and both
availability search and reservation creation need to respect that.

## Goals

- Let each restaurant declare a set of recurring closed weekdays.
- Availability search never offers a closed weekday as bookable.
- Reservation creation rejects a `reservation_date` that falls on a closed
  weekday.
- Bonito is seeded as closed on Sundays.

## Non-goals (explicitly out of scope)

- Applying this to other modules (golf, spa, tours, beach club). Restaurant
  only, matching the current ask.
- Holiday/exception-date overrides (e.g. closed one specific Sunday but open
  the next, or closed an otherwise-open weekday for a one-off event). Pure
  recurring weekday pattern only — a future `restaurant_closed_date`
  exceptions table would be the natural extension if that's ever needed.
- Distinguishing "closed" from "fully booked" in the search response. Closed
  dates are simply omitted from the response, the same as any date with zero
  available slots.

## Data model

```sql
ALTER TABLE restaurant
  ADD COLUMN closed_days SMALLINT[] NOT NULL DEFAULT '{}';
```

Values are ISO day-of-week numbers (`1`=Monday … `7`=Sunday, matching
Postgres's `EXTRACT(ISODOW FROM date)`). No new table — there's no per-day
metadata beyond which weekdays are closed, so a flat array column is
sufficient.

`seed-restaurant-bonito.sql` sets Bonito's `closed_days` to `{7}`.

## Availability search

`GET /:restaurant_id/availability/search?from=&to=&party_size=&location=`

The `candidate_dates` CTE gains a filter excluding closed weekdays. It needs
`r` (the restaurant config row) in scope to read `closed_days`:

```sql
candidate_dates AS (
  SELECT gs::date AS reservation_date
  FROM generate_series($2::date, $3::date, '1 day') AS gs, r
  WHERE NOT (EXTRACT(ISODOW FROM gs)::int = ANY(r.closed_days))
)
```

Everything downstream (candidate_times cross join, the `NOT EXISTS` overlap
check, `GROUP BY`/`HAVING`) is unchanged — a closed weekday just never
produces candidate dates, so it never appears in the grouped response, the
same way a fully-booked date already doesn't.

## Reservation creation

`POST /:restaurant_id/reservations`

The restaurant row is already fetched in `createReservation` (for
`service_start`/`service_end`/`default_duration_minutes`); it now also
carries `closed_days`. After that fetch, before the service-hours check:

1. Compute the ISO day-of-week of `reservation_date` in JS (`1`=Monday …
   `7`=Sunday, matching the SQL side's `ISODOW` convention).
2. If it's in `restaurant.closed_days`, `ROLLBACK` and return
   `400 { "error": "Restaurant is closed on this day" }` — same status code
   as the existing "start_time is outside service hours" check, since this
   validates the input date rather than reporting a capacity conflict.

## Restaurant CRUD

`createRestaurant` accepts an optional `closed_days` array (defaults to
`[]`); `updateRestaurant` accepts it via the existing `COALESCE` pattern.
Both validate that every element is an integer in `1..7`, returning
`400 { "error": "closed_days must contain integers between 1 and 7" }` on
failure.

## Error handling

- `400` — existing validation errors, plus: `reservation_date` falls on a
  closed weekday; `closed_days` contains a value outside `1..7`.
- `404`/`409`/`500` — unchanged.

## Endpoint changes

| Endpoint | Change |
|---|---|
| `GET /:restaurant_id/availability/search` | Closed weekdays excluded from `candidate_dates`; no response shape change. |
| `POST /:restaurant_id/reservations` | New `400` case for closed-weekday `reservation_date`. |
| Restaurant CRUD (`GET/POST/PUT /`) | Gains optional `closed_days` field on create/update. |

## Migration & rollout

Consistent with the rest of this project (no migrations tool; `schema.sql`
is edited in place and applied to a freshly reset dev database):

- `schema.sql`: add `closed_days` to the `restaurant` table definition.
- `seed-restaurant-bonito.sql`: add `closed_days` to Bonito's INSERT,
  set to `{7}`.
- Applying the change is a reset: drop/recreate the dev database (local and
  the `otadb` instance the live Render service uses), rerun `schema.sql`,
  then the seed files.

## Testing approach

No automated test framework in this project — manual checks
(`curl`/`psql` against a running `npm run dev`, or the live Render service):

1. Reset + reseed dev DB with the new column.
2. Search a date range spanning at least one Sunday → confirm no entry for
   that date in the response, while adjacent open days still show slots.
3. Attempt `POST /:restaurant_id/reservations` with a Sunday
   `reservation_date` → confirm `400 "Restaurant is closed on this day"`.
4. Attempt the same for a non-closed weekday → confirm it still succeeds
   (no regression on the existing happy path).
5. `PUT /:restaurant_id` with `closed_days: [1, 7]` → confirm it persists and
   search now also excludes Mondays.
6. `POST`/`PUT` with `closed_days: [0]` or `[8]` → confirm `400`.
