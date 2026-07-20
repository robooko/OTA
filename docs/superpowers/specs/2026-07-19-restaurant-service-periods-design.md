# Restaurant multi-window service periods

## Context

The restaurant module currently models exactly one continuous service window
per restaurant via flat `restaurant.service_start`/`service_end` columns.
The 2026-07-15 availability redesign explicitly flagged this as a known
limitation: "Multiple service windows per day (e.g. lunch and dinner with a
gap in between)... would need a small `service_period` table instead of
flat columns on `restaurant` — a natural follow-up if/when it's needed, not
designed here."

That need has arrived: BBYC (Bora Bora Yacht Club) is open daily with two
separate windows — lunch 11:30–14:30 and dinner 17:30–21:30 — which the
current single-window schema cannot represent.

This also seeds BBYC, but **without the usual full-reset rollout** (see
Migration & rollout below) — the request was specifically to add BBYC
without dropping existing data (including any live reservations created
since the last reset).

## Goals

- Support any number of daily service windows per restaurant.
- Migrate the 4 existing restaurants (Bonito, Bimini, Betula, Barry), each
  keeping their current single window, onto the new model with zero data
  loss.
- Seed BBYC with its real two windows, 5 tables, open every day
  (no `closed_days`).
- Roll this out in place, preserving all existing data — no schema reset.

## Non-goals (explicitly out of scope)

- No API CRUD for `service_period` rows — seed data only, same rationale
  as `restaurant_seasonal_closure`: no consumer currently needs to manage
  these dynamically via the API.
- No per-period `slot_interval_minutes`/`default_duration_minutes` — these
  stay shared at the restaurant level. Nothing today needs, say, a longer
  reservation duration for dinner than lunch.
- No overlap validation between a restaurant's periods (no `EXCLUDE`
  constraint) — trusted seed data, consistent with how this project
  doesn't enforce every possible data invariant at the DB level.
- Not applied to other modules (golf, spa, tours, beach club) —
  restaurant-only.

## Data model

```sql
CREATE TABLE service_period (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurant(id),
  label         VARCHAR(50),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  CHECK (start_time < end_time)
);

CREATE INDEX idx_service_period_restaurant ON service_period(restaurant_id);
```

`restaurant.service_start` and `restaurant.service_end` are **removed**.
`slot_interval_minutes` and `default_duration_minutes` stay on `restaurant`,
shared across all of that restaurant's periods. `label` is optional —
`NULL` for the 4 existing single-window restaurants, `'Lunch'`/`'Dinner'`
for BBYC's two.

## Availability search

`GET /:restaurant_id/availability/search?from=&to=&party_size=&location=`

The `r` CTE drops `service_start`/`service_end`, keeping just
`slot_interval_minutes`, `default_duration_minutes`, `closed_days`.
`candidate_times` is rebuilt to source from `service_period` — one
`generate_series` per period row for the restaurant, naturally unioning
lunch and dinner slots (or just the single window, for everyone else):

```sql
WITH r AS (
  SELECT slot_interval_minutes, default_duration_minutes, closed_days
  FROM restaurant WHERE id = $1
),
candidate_times AS (
  SELECT generate_series(
    DATE '2000-01-01' + sp.start_time,
    DATE '2000-01-01' + sp.end_time - (r.default_duration_minutes || ' minutes')::interval,
    (r.slot_interval_minutes || ' minutes')::interval
  )::time AS start_time
  FROM service_period sp
  CROSS JOIN r
  WHERE sp.restaurant_id = $1
),
candidate_dates AS ( -- unchanged from the closed_days/seasonal-closure work
  ...
)
SELECT ... -- unchanged: still cross-joins candidate_dates × candidate_times × restaurant_table
```

If a period's span is shorter than `default_duration_minutes`,
`generate_series` naturally produces zero rows for that period (an empty
series, not an error) — no special-casing needed.

Everything downstream (the `closed_days` and `restaurant_seasonal_closure`
exclusions in `candidate_dates`, the table-matching `WHERE`, grouping,
`HAVING COUNT(rt.id) > 0`) is unchanged.

## Reservation creation

`POST /:restaurant_id/reservations`

Replaces the single `start_time < serviceStart || end_time > serviceEnd`
check with: fetch the restaurant's `service_period` rows, compute
`end_time` the same way as today (`addMinutesToTime(start_time,
default_duration_minutes)`), and accept the reservation if **any** period
fully contains `[start_time, end_time)` — i.e. `period.start_time <=
start_time && end_time <= period.end_time`. If no period contains it,
same `400 { "error": "start_time is outside service hours" }` as today —
the message already reads correctly generalized to "no matching window."

## Restaurant CRUD & Swagger

`createRestaurant`/`updateRestaurant` drop `service_start`/`service_end`
from: the required-fields check, the `INSERT`/`UPDATE` column lists and
param arrays, and the Swagger request schemas for `POST`/`PUT
/api/restaurant`. A restaurant created via the API has zero `service_period`
rows until seeded directly (same as it has zero tables until `POST
.../tables` is called or seed data adds them) — consistent with periods
being seed-data-only.

## Seed data changes

- `seed-restaurant-bonito.sql`, `seed-restaurant-bimini-betula-barry.sql`:
  remove `service_start`/`service_end` from each restaurant's `INSERT`
  column list and `VALUES`; add a chained `service_period` insert (one row,
  `label = NULL`) using the same `new_restaurant.id` pattern already used
  for `restaurant_table` (and, for Betula, `restaurant_seasonal_closure`).
- New `seed-restaurant-bbyc.sql`: BBYC restaurant (no `service_start`/
  `service_end` — those columns won't exist), two `service_period` rows
  (`('Lunch', '11:30', '14:30')`, `('Dinner', '17:30', '21:30')`), 5 tables
  (`T1` 2-Marina, `T2` 2-Marina, `T3` 4-Indoor, `T4` 4-Indoor, `T5`
  6-Terrace), `closed_days = '{}'` (open every day, matching "Monday to
  Sunday").

## Migration & rollout

**Deliberately not this project's usual full-reset convention** — the
request was to preserve existing data (including any live reservations).
A one-time script, run directly against each database with `psql`/`node`
(not through the reset pipeline):

1. `CREATE TABLE service_period (...)` + its index — additive, no data at
   risk.
2. `INSERT INTO service_period (restaurant_id, start_time, end_time)
   SELECT id, service_start, service_end FROM restaurant;` — migrates all
   4 existing restaurants' current windows into the new table in one
   statement.
3. `ALTER TABLE restaurant DROP COLUMN service_start, DROP COLUMN
   service_end;`
4. Run `seed-restaurant-bbyc.sql` directly — a plain additive `INSERT`,
   same as any other seed file, safe to run against an already-populated
   database.

`schema.sql` and the two existing restaurant seed files are still updated
to reflect the new shape (no `service_start`/`service_end`, `service_period`
included), so that any *future* full reset — for an unrelated change —
produces the same end state without needing this migration again.

Both the local Postgres and the remote `otadb` instance need this same
migration run against them (their current data has diverged since each
was last reset, and both need preserving).

## Testing approach

No automated test framework in this project — manual checks (`curl`/`psql`
against a running `npm run dev`, or the live Render service):

1. Run the migration against the local dev DB. Confirm: `service_period`
   has exactly 4 rows before BBYC is seeded (one per existing restaurant),
   `restaurant` no longer has `service_start`/`service_end` columns, and
   existing data (a pre-migration reservation, if any) still exists
   unchanged.
2. Confirm Bonito's availability search still returns the same slots as
   before the migration (regression check — single-window restaurants
   shouldn't change behavior).
3. Run `seed-restaurant-bbyc.sql`. Confirm BBYC appears in
   `GET /api/restaurant` and has 2 `service_period` rows and 5 tables.
4. Search BBYC for a date → confirm start times appear in **both** the
   11:30–14:30 and 17:30–21:30 ranges, with a gap in between (no slots
   14:30–17:30).
5. `POST` a BBYC reservation with `start_time` inside the lunch window →
   `201`. Inside the dinner window → `201`. In the gap (e.g. `15:00`) →
   `400 "start_time is outside service hours"`.
6. `POST /api/restaurant` (create) without `service_start`/`service_end` in
   the body → still `201` (no longer required); the created restaurant has
   zero `service_period` rows, and its availability search returns no
   slots (no periods to generate candidate times from) — not an error.
