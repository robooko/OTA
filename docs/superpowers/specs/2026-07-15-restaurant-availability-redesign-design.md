# Restaurant availability & reservations — Redesign

## Context

The restaurant module (`restaurant`, `restaurant_table`, `time_slot`,
`restaurant_reservation`) models availability as a pre-generated grid: one
`time_slot` row per bookable start time, each carrying its own
`available_seats` counter that a reservation decrements/restores.

This worked when slots were seeded hours apart (13:00 lunch, 20:00 dinner),
but Bonito's restaurant now needs 15-minute granularity across a dinner
service window, which exposed two problems:

1. **No overlap protection.** A reservation locks exactly one
   `(table_id, time_slot_id)` pair. At 15-minute granularity, nothing stops
   the same table being booked again 15 minutes later for a meal that's
   still in progress — the model has no concept of a reservation's
   *duration*.
2. **Seeding burden.** Every restaurant needs its slot grid generated and
   kept in sync (as just happened manually for Bonito). This doesn't scale
   to "simple and fast" as slot granularity increases or more restaurants
   are added.

The goal of this redesign: drop the pre-generated grid entirely and compute
availability on demand from table capacity + existing reservations, while
keeping search fast (one indexed query, no N+1) and closing the
double-booking gap.

## Goals

- Remove `time_slot` as a stored grid; nothing to seed or keep in sync per
  restaurant.
- Give each reservation a real duration, and prevent two reservations from
  overlapping on the same table.
- Support searching a **date range** in one call (the frontend shows a
  "closed today — here's what's available this week" view across several
  days at once).
- Group search results by **table location** (Indoor/Terrace), matching how
  the frontend presents choices.
- Auto-assign a table at booking time — the caller specifies time + party
  size (+ optional location preference), not a specific `table_id`.

## Non-goals (explicitly out of scope)

- Multiple service windows per day (e.g. lunch *and* dinner with a gap
  in between). This models a single continuous service window per
  restaurant, matching Bonito's current dinner-only setup. Supporting
  day-parts would need a small `service_period` table instead of flat
  columns on `restaurant` — a natural follow-up if/when it's needed, not
  designed here.
- Day-of-week variation in service hours (e.g. shorter hours Sunday).
- A cached/materialized read model (mirroring the hotel side's
  `room_type_availability` view). Not needed at current scale; the
  single-query approach below is expected to stay fast well past current
  volumes. Revisit only if the live query itself becomes the bottleneck.
- Scoping this module to `property_id` (the multi-property rollout's
  Phase 2, per `2026-07-12-multi-property-design.md`). Independent of this
  work — the redesigned tables gain a `property_id` column in that phase
  the same way any other restaurant-module column would.
- Backfilling existing `otadb` test reservations into the new schema. Rollout
  is a clean reset like every other schema change in this project; the
  live reservations created during development testing are not preserved.

## Data model

### `restaurant` — add service configuration

```sql
ALTER TABLE restaurant
  ADD COLUMN service_start            TIME NOT NULL,
  ADD COLUMN service_end              TIME NOT NULL,
  ADD COLUMN slot_interval_minutes    INT  NOT NULL DEFAULT 15,
  ADD COLUMN default_duration_minutes INT  NOT NULL;
```

One row of config per restaurant — no daily seeding. `slot_interval_minutes`
is how far apart bookable start times are (search granularity);
`default_duration_minutes` is how long a table is held per reservation.

### `time_slot` — dropped

No replacement table. Availability is computed at request time.

### `restaurant_reservation` — replace `time_slot_id` with a real time range

```sql
ALTER TABLE restaurant_reservation
  DROP COLUMN time_slot_id,
  ADD COLUMN reservation_date DATE NOT NULL,
  ADD COLUMN start_time       TIME NOT NULL,
  ADD COLUMN end_time         TIME NOT NULL;
```

`end_time` is computed from the restaurant's `default_duration_minutes` **at
booking time** and stored — a later change to the restaurant's duration
setting never retroactively changes existing reservations' effective length.

`table_id` stays (still `NOT NULL REFERENCES restaurant_table(id)`), but is
now system-assigned rather than caller-specified (see Reservation creation).

### Indexes

```sql
CREATE INDEX idx_restaurant_res_table_date_time
  ON restaurant_reservation(table_id, reservation_date, start_time);
```

Replaces the old `(table_id, time_slot_id)` index — this is what both the
search query and the booking-time overlap check use.

## Search

`GET /api/restaurant/:restaurant_id/availability/search?from=&to=&party_size=&location=`

Replaces `GET /:restaurant_id/slots/search`. `from`/`to` are inclusive dates;
`location` is optional (omit to search all locations); `party_size` is
required.

One query per request — candidate times are generated from the restaurant's
own config via `generate_series`, cross-joined against qualifying tables,
with a `NOT EXISTS` correlated subquery excluding any table that has an
overlapping confirmed reservation:

```sql
WITH r AS (
  SELECT service_start, service_end, slot_interval_minutes, default_duration_minutes
  FROM restaurant WHERE id = $restaurant_id
),
candidate_times AS (
  SELECT generate_series(
    r.service_start,
    r.service_end - (r.default_duration_minutes || ' minutes')::interval,
    (r.slot_interval_minutes || ' minutes')::interval
  )::time AS start_time
  FROM r
),
candidate_dates AS (
  SELECT generate_series($from::date, $to::date, '1 day')::date AS reservation_date
)
SELECT cd.reservation_date, ct.start_time, rt.location, COUNT(rt.id) AS available_tables
FROM candidate_dates cd
CROSS JOIN candidate_times ct
CROSS JOIN restaurant_table rt
WHERE rt.restaurant_id = $restaurant_id
  AND rt.status = 'active'
  AND rt.seats >= $party_size
  AND ($location IS NULL OR rt.location = $location)
  AND NOT EXISTS (
    SELECT 1 FROM restaurant_reservation rr, r
    WHERE rr.table_id = rt.id
      AND rr.reservation_date = cd.reservation_date
      AND rr.status != 'cancelled'
      AND rr.start_time < ct.start_time + (r.default_duration_minutes || ' minutes')::interval
      AND rr.end_time   > ct.start_time
  )
GROUP BY cd.reservation_date, ct.start_time, rt.location
HAVING COUNT(rt.id) > 0
ORDER BY cd.reservation_date, ct.start_time, rt.location;
```

Candidate times stop at `service_end - default_duration_minutes`, so a
booking can never be offered a start time that would run past closing.

The controller groups the flat rows into a per-date response:

```json
[
  { "date": "2026-07-15", "slots": [
    { "time": "19:00", "location": "Indoor",  "available_tables": 2 },
    { "time": "19:00", "location": "Terrace", "available_tables": 1 },
    { "time": "19:15", "location": "Indoor",  "available_tables": 2 }
  ]}
]
```

## Reservation creation

`POST /:restaurant_id/reservations` body:
`{ party_size, reservation_date, start_time, location?, contact_name, contact_email?, contact_phone?, guest_id?, notes? }`

No `table_id` or `time_slot_id` from the caller — table assignment is
automatic.

1. Validate required fields and date/time formats.
2. Look up the restaurant's `service_start`/`service_end`/
   `slot_interval_minutes`/`default_duration_minutes`.
3. `400` if `start_time` falls outside service hours or isn't aligned to the
   slot-interval grid — keeps bookable times consistent with what search
   shows.
4. Compute `end_time = start_time + default_duration_minutes`.
5. In a transaction: `SELECT` candidate tables (matching location if given,
   `seats >= party_size`, `status = 'active'`, smallest-seats-first so small
   parties don't consume large tables) with `FOR UPDATE SKIP LOCKED`, then
   check each in order for an overlapping confirmed reservation (same
   condition as search) until one is free.
6. No table available → `ROLLBACK`, `409 { "error": "No tables available for this time" }`.
7. Insert the reservation with the assigned `table_id`, `reservation_date`,
   `start_time`, `end_time`, `status: 'confirmed'`. Commit, return `201`
   (include the assigned table's `table_number`/`location` in the response
   for the confirmation UI).

`FOR UPDATE SKIP LOCKED` is what prevents two concurrent requests from
double-booking the same table for an overlapping window — a real gap in the
current code that this closes.

`updateReservation` (status/notes/contact changes) is otherwise unchanged,
**except** it no longer needs to restore any `available_seats` counter on
cancellation — since availability is always computed live from
non-cancelled reservations, there's nothing to keep in sync.

## Error handling

- `400` — missing fields, invalid date/time format, `start_time` outside
  service hours or off the slot-interval grid, `party_size <= 0`.
- `404` — restaurant/reservation not found (unchanged).
- `409` — `"No tables available for this time"` (replaces the old
  "already reserved for this time slot" / "not enough available seats"
  errors — one clear message now that assignment is automatic).
- `500` — unchanged, via existing `errorHandler` middleware.

## Endpoint changes

| Endpoint | Change |
|---|---|
| `GET/POST /:restaurant_id/slots`, `POST /:restaurant_id/slots/bulk` | **Removed** — no more `time_slot` rows to manage |
| `GET /:restaurant_id/slots/search` | **Renamed & changed** → `GET /:restaurant_id/availability/search` (date range, location grouping, new response shape) |
| `POST /:restaurant_id/reservations` | **Changed** — new request shape, auto table assignment |
| `PUT /:restaurant_id/reservations/:id` | **Simplified** — cancellation no longer restores a counter |
| `GET /:restaurant_id/reservations`, `GET /:restaurant_id/reservations/:id` | **Adjusted** — join on `reservation_date`/`start_time` instead of `time_slot_id`; otherwise unchanged |
| Restaurant CRUD (`GET/POST/PUT /`) | **Unchanged**, gains the 4 new config fields on create/update |
| Table CRUD (`GET/POST/PUT /:restaurant_id/tables`) | **Unchanged** |

## Migration & rollout

Consistent with the rest of this project (no migrations tool; `schema.sql`
is edited in place and applied to a freshly reset dev database):

- `schema.sql`: add the 4 `restaurant` columns, drop `time_slot`, alter
  `restaurant_reservation`, update indexes.
- `seed-restaurant-bonito.sql`: set Bonito's `service_start`/`service_end`/
  `slot_interval_minutes`/`default_duration_minutes` to `19:00`, `22:30`,
  `15`, and `90` (a 90-minute default dinner reservation). `service_end` is
  `22:30`, not `21:00` as originally sketched — with a 90-minute duration, a
  2-hour window only yields 3 bookable start times (19:00-19:30); widening
  to `22:30` restores 9 start times (19:00-21:00 every 15 min), matching the
  slot count this restaurant had before the redesign. Drop the old direct
  `time_slot` inserts.
- Applying the change is a reset: drop/recreate the dev database (local and
  the `otadb` instance the live Render service uses), rerun `schema.sql`,
  then the seed files. The reservations created during this session's live
  testing are not preserved (see Non-goals).

## Testing approach

No automated test framework in this project — every check below is manual
(`curl`/`psql` against a running `npm run dev`, or the live Render service):

1. Reset + reseed dev DB with the new schema.
2. Search across a date range → confirm results grouped by date → time →
   location, with correct `available_tables` counts.
3. Create a reservation, re-run search for that same time/location →
   confirm the table count drops by one (or the slot disappears if it was
   the last table).
4. Concurrency: fire two simultaneous booking requests for the same
   time/location/party_size where only one table qualifies → confirm
   exactly one succeeds (`201`) and the other gets `409`.
5. Boundary: attempt a booking whose `start_time` would run past
   `service_end` → confirm `400`.
6. Cancel a reservation, re-run search for that slot → confirm the table
   reappears as available (no manual counter to restore).
