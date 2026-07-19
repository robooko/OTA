# Restaurant seasonal closures

## Context

`docs/superpowers/specs/2026-07-17-restaurant-closed-days-design.md` added
`restaurant.closed_days` for recurring **weekly** closures (Bonito is closed
every Sunday). Betula needs a different kind of recurring closure: it's
closed for a few weeks every spring (mid-April–late May) and every fall
(October–late November), regardless of day of week. That spec's Non-goals
mentioned a possible future `restaurant_closed_date` table for one-off
exception dates — this is a related but distinct need: not one-off dates,
but recurring **annual date ranges**.

Also fixing a seed data mistake found while gathering these requirements:
Betula was seeded with `service_start`/`service_end` of `18:00`/`22:00`;
it's actually open `17:30`–`23:00`.

## Goals

- Let a restaurant have zero or more recurring annual closure windows
  (month/day ranges, no year component — the range applies every year).
- Availability search never offers a date inside a closure window.
- Reservation creation rejects a `reservation_date` that falls inside one.
- Seed Betula with its two actual closure windows, and correct its service
  hours.

## Non-goals (explicitly out of scope)

- No API CRUD for seasonal closures (no new routes/controller functions) —
  seed data only, same rationale as keeping this scoped to what's actually
  needed right now.
- No year-wrapping windows (e.g. Dec 20–Jan 10). Only `start (month, day) <=
  end (month, day)` within a single calendar year is supported, enforced by
  a `CHECK` constraint. A wrapping closure would need two rows (e.g.
  Dec 20–Dec 31 and Jan 1–Jan 10) if ever needed.
- Not applied to other modules (golf, spa, tours, beach club) — restaurant
  only, matching `closed_days`.
- No change to how `closed_days` works — this is an additional, independent
  exclusion, not a replacement.

## Data model

```sql
CREATE TABLE restaurant_seasonal_closure (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID     NOT NULL REFERENCES restaurant(id),
  start_month   SMALLINT NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_day     SMALLINT NOT NULL CHECK (start_day BETWEEN 1 AND 31),
  end_month     SMALLINT NOT NULL CHECK (end_month BETWEEN 1 AND 12),
  end_day       SMALLINT NOT NULL CHECK (end_day BETWEEN 1 AND 31),
  CHECK (ROW(start_month, start_day) <= ROW(end_month, end_day))
);

CREATE INDEX idx_restaurant_seasonal_closure_restaurant
  ON restaurant_seasonal_closure(restaurant_id);
```

One row per closure window — a restaurant with no seasonal closures simply
has no rows (no `restaurant` column involved, unlike `closed_days`). Betula
gets two rows: `(4, 15, 5, 25)` (Apr 15–May 25) and `(10, 1, 11, 25)`
(Oct 1–Nov 25).

## Availability search

`GET /:restaurant_id/availability/search?from=&to=&party_size=&location=`

The `candidate_dates` CTE (already excluding `closed_days` weekdays, per the
prior spec) gains a second exclusion:

```sql
candidate_dates AS (
  SELECT gs::date AS reservation_date
  FROM generate_series($2::date, $3::date, '1 day') AS gs
  CROSS JOIN r
  WHERE NOT (EXTRACT(ISODOW FROM gs)::int = ANY(r.closed_days))
    AND NOT EXISTS (
      SELECT 1 FROM restaurant_seasonal_closure sc
      WHERE sc.restaurant_id = $1
        AND ROW(EXTRACT(MONTH FROM gs)::int, EXTRACT(DAY FROM gs)::int)
            BETWEEN ROW(sc.start_month, sc.start_day) AND ROW(sc.end_month, sc.end_day)
    )
)
```

Same convention as `closed_days`: a date inside a closure window is simply
absent from the response, no shape change, no `closed: true` flag.

## Reservation creation

`POST /:restaurant_id/reservations`

Immediately after the existing `closed_days` check (see the prior spec),
before the service-hours check, add a second query:

```js
const seasonRes = await client.query(
  `SELECT 1 FROM restaurant_seasonal_closure
   WHERE restaurant_id = $1
     AND ROW(EXTRACT(MONTH FROM $2::date)::int, EXTRACT(DAY FROM $2::date)::int)
         BETWEEN ROW(start_month, start_day) AND ROW(end_month, end_day)`,
  [restaurant_id, reservation_date]
);
if (seasonRes.rows.length) {
  await client.query('ROLLBACK');
  return res.status(400).json({ error: 'Restaurant is closed on this day' });
}
```

Deliberately reuses the exact same `400 "Restaurant is closed on this day"`
message as the `closed_days` check — from the caller's perspective both
mean "not bookable at this restaurant on this date," and a single error
string is simpler to handle than distinguishing weekday-closed from
season-closed.

## Error handling

- `400` — `reservation_date` falls inside a seasonal closure window (in
  addition to the existing closed-weekday case, same message).
- `404`/`409`/`500` — unchanged.

## Endpoint changes

| Endpoint | Change |
|---|---|
| `GET /:restaurant_id/availability/search` | Dates inside a seasonal closure window excluded from `candidate_dates`; no response shape change. |
| `POST /:restaurant_id/reservations` | Same `400 "Restaurant is closed on this day"` now also covers seasonal closures. |
| Restaurant CRUD, tables, `closed_days` | Unchanged — no new fields, no new routes. |

## Seed data changes

`seed-restaurant-bimini-betula-barry.sql`:
- Betula's `service_start`/`service_end`: `18:00`/`22:00` → `17:30`/`23:00`.
- Two new `restaurant_seasonal_closure` rows for Betula (inserted using the
  same `WITH new_restaurant AS (...) RETURNING id` id captured for that
  restaurant's block): `(4, 15, 5, 25)` and `(10, 1, 11, 25)`.

## Migration & rollout

Consistent with the rest of this project: `schema.sql` edited in place,
applied to a freshly reset dev database (drop/recreate), same as every
prior schema change here.

- `schema.sql`: add the `restaurant_seasonal_closure` table + index.
- `seed-restaurant-bimini-betula-barry.sql`: fix Betula's service hours,
  add the two closure rows.
- Applying the change is a reset: drop/recreate the dev database (local and
  the `otadb` instance the live Render service uses), rerun `schema.sql`,
  then the seed files.

## Testing approach

No automated test framework in this project — manual checks (`curl`/`psql`
against a running `npm run dev`, or the live Render service):

1. Reset + reseed dev DB with the new table and corrected seed data.
2. Confirm Betula's `service_start`/`service_end` are `17:30:00`/`23:00:00`.
3. Search Betula across a date range spanning into the spring closure
   (e.g. April 10–20) → confirm dates from April 15 onward are absent while
   April 10–14 still show slots.
4. Search Betula across a range spanning into the fall closure (e.g.
   November 20–30) → confirm November 20–25 absent, 26–30 present.
5. Search a date clearly outside both closures (e.g. July) → confirm slots
   still appear (no false-positive exclusion).
6. `POST` a reservation with `reservation_date` inside a closure window
   (e.g. `2026-05-01`) → confirm `400 "Restaurant is closed on this day"`.
7. `POST` a reservation on a date outside any closure → confirm it still
   succeeds (no regression).
