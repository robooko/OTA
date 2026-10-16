# Equipment hire: hourly time windows

Agreed with Robert, 16 Oct 2026. Driven by Escuela Puerto Portals
(portals site): kayaks, paddleboards and RS dinghies hired for 1 or 2 hours
from a start time the customer picks. Today those are faked as one-day
course runs; this change lets them move to the equipment module.

## Problem

`equipment_hire` already stores `start_time`, `rate_type` and `duration`,
but availability ignores them: `searchEquipment` and `createHire` sum every
non-cancelled hire on the `hire_date`. With 4 kayaks, four one-hour hires at
10:00, 11:00, 15:00 and 16:00 sell kayaks out for the whole day.

Also: `createHire` reads the hired count without a lock, so two concurrent
hires can both pass the check; `updateHire` reinstating a cancelled hire
skips the check entirely; `quantity` and `duration` are not validated.

## Decisions

1. **A hire occupies a time window.** A `per_hour` hire with a
   `start_time` occupies `[start_time, start_time + duration hours)` on
   `hire_date`. Every other hire (`per_day`, or no `start_time`) occupies
   the whole day, exactly as today. Golf and any existing per-day caller
   behave the same.
2. **Availability is peak concurrent use, not a sum.** Units in use over a
   window = the highest number of units out at any instant inside it.
   Back-to-back hires (10–11 then 11–12) don't overlap. Peak use only
   changes at a hire's start, so it is enough to evaluate at the window's
   start and at each overlapping hire's start inside the window.
3. **Opening hours live on the item.** New nullable `open_time` /
   `close_time` and `slot_interval_minutes` (default 60) on `equipment`.
   When both times are set, a timed hire must start at or after
   `open_time` and end at or before `close_time`. Unset = no hours limit
   (the window must still end by 24:00).
4. **Start times are computed, not stored.** No slot table (spa's
   computed-availability approach, not tours' slot rows). Search can list
   the bookable start times for a duration.
5. **OTA does not take payment** (unchanged). A booking site holding units
   while it charges the card uses a normal `confirmed` hire with its own
   notes marker and cancels it if payment fails, as the portals courses
   checkout already does. No pending status, no expiry sweep in OTA.
6. **Duration** is hours for `per_hour`, days for `per_day` (unchanged
   meaning). For `per_hour` it must be a positive multiple of 0.5. Multi-day
   `per_day` hires still only occupy `hire_date`; out of scope here.

Builder's calls (made while writing this up, not discussed with Robert):

7. **Search reuses the hire rules.** With `start_time`, an item that has no
   `price_per_hour`, or whose hours the window doesn't fit, is left out of
   the results, so search never offers what `POST /hires` would refuse.
8. **Off-grid starts are allowed.** `POST /hires` accepts any valid
   `HH:MM` inside the hours (staff can book 10:15 by hand); only
   `start_times` sticks to the `slot_interval_minutes` grid.
9. **No past starts.** When `date` is today in `property.timezone`,
   `start_times` drops starts before now, and `POST /hires` refuses a timed
   hire starting before now (400 "That time has passed"). `hire_date`
   before today stays allowed, as now (staff back-entry). `startTimes`
   takes `now` (minutes, or null) as an argument so it stays pure.
10. **Hours can be cleared.** On `PUT /api/equipment/:id`, an explicit
    `null` for `open_time` / `close_time` clears it; an absent key leaves it.
    The update locks the row, merges the body over it, validates the merged
    row (both or neither, `close_time > open_time`), then writes.

## Data model

```sql
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS open_time  TIME;
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS close_time TIME;
ALTER TABLE equipment ADD COLUMN IF NOT EXISTS slot_interval_minutes INT NOT NULL DEFAULT 60;
```

Validation on create/update: `open_time` and `close_time` are both set or
both null, `close_time > open_time`, `slot_interval_minutes` between 5 and
240. `quantity` is a positive integer; prices are non-negative.

## Shared logic

`src/lib/equipmentWindows.js`, pure:

- `hireWindow(hire)` → `{ start, end }` in minutes from midnight; whole day
  is `{ 0, 1440 }`.
- `peakUse(hires, window)` → max units out at any instant in `window`,
  given the day's non-cancelled hires of one item.
- `startTimes(item, hires, durationHours, quantity)` → every start from
  `open_time` (or 00:00) in `slot_interval_minutes` steps whose window fits
  the hours, each with `available_quantity = item.quantity − peakUse`,
  keeping only those with `available_quantity ≥ quantity` (default 1).

## API — `/api/equipment` changes

| Method | Path | Change |
|---|---|---|
| POST / PUT | `/`, `/:id` | Accept `open_time`, `close_time`, `slot_interval_minutes`; validate as above |
| GET | `/search` | New optional `start_time`, `duration` (hours, default 1). `available_quantity` = quantity − peak use over the requested window: `[start_time, +duration)` if `start_time` is given, else the whole day. `quantity` filter applies to that number. Without `start_time`, each item with `price_per_hour` also gets `start_times: [{ start_time, available_quantity }]` for `duration` |
| POST | `/hires` | Window-aware check under a lock (below) |
| PUT | `/hires/:id` | Reinstating (`cancelled` → not cancelled) re-runs the availability check under the same lock; 409 if it no longer fits |

The `quantity` filter in search moves from string-built `HAVING` to the JS
step (or a bound parameter); no interpolated values in SQL.

### `POST /api/equipment/hires`

One transaction:

1. Validate: required fields as today; `quantity` positive integer;
   `rate_type` in `per_day` / `per_hour`; `duration` positive (multiple of
   0.5 for `per_hour`); `start_time` valid `HH:MM` if given → else 400.
2. `SELECT … FROM equipment WHERE id AND property_id FOR UPDATE` → 404 /
   409 as today. The row lock serialises hires on one item.
3. If timed (`per_hour` + `start_time`) and the item has hours, the window
   must fit them → 400 "Hire must be between 09:00 and 19:00". Window must
   end by 24:00 → 400.
4. Load the item's non-cancelled hires on `hire_date`;
   `quantity > item.quantity − peakUse(hires, window)` → 409
   "Only N available from 10:00 to 12:00" (or "on this date" for whole-day).
5. Price and insert as today; commit; 201.

`PUT /api/equipment/:id` takes the same row lock (see decision 10). Lowering `quantity` below
current bookings is allowed (staff decision), as today.

## Files

- `src/db/migrate-2026-10-16-equipment-hours.sql` — the DDL above; same
  columns added to the `equipment` table in `src/db/schema.sql`.
- `src/lib/equipmentWindows.js` — new.
- `src/controllers/equipment.js` — search, createHire, updateHire,
  create/update validation.
- `src/docs/swagger.js` — new fields and params.
- `mcp-server/tools.js` — `create_equipment` / `update_equipment` gain the
  hours fields; `search_equipment` gains `start_time` / `duration`.

## Testing

`scripts/check-equipment.js`, run with
`node -r dotenv/config scripts/check-equipment.js`, following
`check-courses.js`: real app on an ephemeral port, local DB only, fixtures
under a throwaway property deleted at the end, `ok` / `FAIL` lines,
non-zero exit on failure. `equipmentWindows` functions asserted directly.

Checks:

- Quantity 1: 10–11 then 11–12 both succeed (back-to-back); 10:30–11:30
  then 409.
- Quantity 2: hires 10–11 and 11–12, then 10–12 succeeds (peak 2, not 3);
  a further 10–12 gets 409.
- Per-day hire occupies the whole day: blocks a timed hire on a quantity-1
  item, and vice versa.
- Hours: 08:00 start or a window past `close_time` → 400.
- `start_times` for 2 hours lists only starts with room, ending by close.
- Cancel frees the window; reinstating into a now-full window → 409.
- Two concurrent hires for the last unit: exactly one 201, one 409.
- Validation: `quantity: 0`, `duration: -1`, `duration: 0.7` per hour,
  `start_time: '25:00'` → 400.
- Search with `start_time` leaves out a per-day-only item and one whose
  hours don't fit.
- `startTimes` with `now` = 12:00 drops 10:00 and 11:00; a timed hire today
  in the past → 400.
- `PUT` with `open_time: null, close_time: null` clears hours; `close_time`
  alone before the stored `open_time` → 400.

## Out of scope

- Multi-day `per_day` hires occupying more than `hire_date`.
- Per-weekday or seasonal opening hours, closures.
- Pending/expiring holds inside OTA.
- The portals site's hire checkout and moving the 8 rental courses; that is
  a separate portals spec once this ships.
