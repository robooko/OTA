# Room-type overbooking, room picks and per-night rooms — design

2026-11-05. API only; dashboard and staff-app UI come later on top of it.

## Why

Hotels lose revenue on rooms that are booked and then cancelled late. The cancel-risk model
(`booking_cancel_score`, scored by `antonio-zahara/ml/score_bookings.py`) already says how many
booked rooms per night and type will probably cancel (`ml/overbooking.py`, backtested in
`ml/backtest_overbooking.py`). This feature lets OTA actually sell those rooms.

Today it can't: a booking always holds one physical room for its whole stay, and
`booking_no_overlap` plus the per-room `room_availability.is_available` flags stop a type from
being sold past its rooms.

Robert also wants **picking a specific room to be a proper feature**. Today OTA auto-assigns a room
at booking time, which can block the room a later guest actually wanted or needed (sea view,
accessible).

This is the real version, not a test harness. Robert: "work is real, I don't want to rework later".

## Goals

1. A booking records the **room type it was sold as**, separately from the rooms it occupies.
2. **Rooms are held per night.** A stay can use different rooms on different nights. At check-in a
   guest can take a room that is free tonight even if it isn't free for the whole stay, and staff
   move them later.
3. **Auto-assign at booking, picks win.** A booking gets rooms straight away when rooms are free.
   - These rooms are **auto-assigned**.
   - A booking that names a room is **picked**.
   - A new pick may **bump** an auto-assigned booking off a room, up to a per-property cutoff
     before that booking's arrival (default 1 day).
4. **Overbooking.** A type can be sold past its rooms by an oversell allowance per night × type.
   - **The model leads:** it posts allowances.
   - **A manager can adjust:** a manual override per night × type.
   - **A per-property hard cap.**
   - **Off per property by default.**
5. Every sales path respects the same availability: direct API/MCP bookings, website checkout (the
   same `createBooking` via API key), search, channel pushes and channel reservations.
6. **Walked guests** get their own status. No cancellation terms, no cancel email, and kept apart
   from cancellations for the backtest.
7. **Front-desk endpoints:**
   - oversold arrivals;
   - nights still needing a room;
   - room moves (check-in placement, upgrade, downgrade, mid-stay).

## Non-goals

- UI.
- Automatic price changes on a move. **The price stays as booked; refunds are manual** (Robert).
- Training or running the model inside OTA. The model stays in antonio-zahara and posts allowances.
- Automating the walk itself (finding another hotel). Staff do that and set the status.

## Anti-goals (a failure even if it works)

- Overselling on a property that hasn't switched it on, or past its cap.
- Any existing flow silently dropping or erroring on a booking that has no room on some or all
  nights. That covers bookings list, folio, emails, baskets, housekeeping and channels.
- Two live bookings in the same room on the same night.
- A pick bumping a picked booking, a checked-in booking, or a booking inside the cutoff.
- Anyone without `overbooking.manage` turning overbooking on, raising the cap or changing
  allowances.

## Decisions

Decisions marked *(Robert)* are his. The rest are design calls he can overturn.

- **Per-night rooms** *(Robert)*. Source of truth is `booking_night`. See Data.
- **Auto-assign + pick + bump with a cutoff** *(Robert)*. Cutoff default 1 day *(Robert: "default
  the cutoff")*, per-property setting.
- **Moves keep the price; refunds manual** *(Robert)*.
- **Permissions** *(Robert: "admin or all/scoped key")*. One new permission, `overbooking.manage`,
  checked with the existing `requirePermission`. Admins and full API keys pass, and so do staff
  grants and scoped keys listing it. It gates:
  - the on/off switch and cap;
  - the model's allowance posts;
  - manual overrides.
- **Walked status** *(Robert)*.
- The switch and cap live on **dedicated columns set only through the gated overbooking settings
  endpoint**, not in `enabled_modules`, because `PUT /api/property/me` has no permission gate.
- Early check-out frees the remaining nights.
- A model post **replaces** its date range. Nights in `[from, to)` it omits go to model allowance 0,
  so a stale value can't keep overselling.

## Design

### Data

- **`booking.room_type_id UUID NOT NULL REFERENCES room_type(id)`**, the type as sold. The
  migration backfills it from the current room's type.
- **`booking.room_pick BOOLEAN NOT NULL DEFAULT false`**. True when the booking named its room,
  which can then never be bumped. Existing bookings created with an explicit `room_id` can't be
  told apart from auto-assigned ones, so they backfill to false.
- **`booking_night (booking_id, property_id, night DATE, room_id NULL REFERENCES room(id))`**,
  `PRIMARY KEY (booking_id, night)`. There is one row per night of the stay, and `room_id NULL`
  means that night has no room yet. Replace `booking_no_overlap` with an EXCLUDE (or partial
  unique index) on `(room_id, night)` for rows whose booking is live. The builder picks the
  mechanism; the night rows can carry a denormalized `live` flag, or rows can be deleted when a
  booking leaves live.
- **`booking.room_id` becomes nullable and means "current room"**: tonight's room once the stay has
  started, otherwise the first night's room. It is kept up to date by the one helper that writes
  `booking_night`. It is a read convenience for the many existing readers (emails, folio, payloads)
  and nothing enforces anything on it.
- **`booking_room_move (id, property_id, booking_id, night_from, night_to, from_room_id NULL,
  to_room_id NULL, reason, moved_at, moved_by)`**, where `reason` is one of
  `assign | bump | upgrade | downgrade | move | release`. It is append-only and records "sold as A,
  got D" for later analysis.
- **`booking.status`** gains `walked`. It is not live, so it holds nothing and counts nowhere.
- **`room_type_oversell (property_id, room_type_id, date, model_allowance INT NOT NULL DEFAULT 0,
  manual_allowance INT NULL, model VARCHAR(100), updated_at)`**, `PRIMARY KEY (room_type_id, date)`,
  with both allowances ≥ 0.
  **Effective allowance** = `LEAST(COALESCE(manual_allowance, model_allowance), cap)`.
- **`property.overbooking_enabled BOOLEAN NOT NULL DEFAULT false`**,
  **`property.oversell_max_pct NUMERIC(5,2) NOT NULL DEFAULT 0`** (cap = floor(pct × the type's
  active rooms)), and **`property.room_lock_days INT NOT NULL DEFAULT 1`** (pick cutoff).
  When overbooking is disabled, effective allowance = 0.

### Availability is a count per type and night

```
sellable(type, night) = active_rooms(type) - blocked_rooms(type, night)
                        - live_bookings_sold_as(type, night) + effective_allowance(type, night)
```

- `blocked_rooms` are rooms closed by staff in `room_availability` (maintenance and similar), not
  by bookings.
- A booking counts against its **sold** type on every night, whatever room it sits in. An upgraded
  guest therefore still uses an A slot, not a D one.

This deliberately replaces "count the open room flags". `room_availability` keeps rate overrides
and staff blocks. Booking placement stops writing `is_available`, because `booking_night` is the
occupancy record. **Builder must migrate** the readers of `is_available` that mean occupancy:

- `placeBooking`;
- `releaseAvailability`;
- `room_type_availability`;
- search;
- `desiredAri`.

The migration converts existing booking-closed flags into `booking_night` rows and reopens them.
It must tell booking closures from staff blocks by matching them against live bookings.

`room_type_availability` keeps `total_rooms`, `available_rooms` (rooms free of bookings and blocks)
and `min_rate`. It gains `sold`, `oversell_allowance` and `sellable_rooms`. Search and `desiredAri`
use `sellable_rooms`.

Picking a room additionally needs that room free of picked bookings, checked-in bookings and blocks
on every night. It must also satisfy the type count, so a pick can't strand a type booking.

### Taking a booking: one helper used by every path

`createBooking` (`src/controllers/bookings.js:131`) and the channel `handleNew`/`handleModify`
(`src/lib/channels/reservations.js`) call one helper inside the booking transaction, under a
per-property-and-type advisory lock:

1. Check `sellable ≥ 1` on every night for the sold type, or reject (409 for the API, the existing
   "no room available" path for channels).
2. **Picked room** (`room_id` given): the room's type is the sold type.
   - On each night the room must be free of picked, checked-in and blocked holds.
   - Any auto-assigned holder there that is outside the cutoff is bumped. The bumped booking is
     re-placed in another room of its sold type for those nights, or left with no room on them if
     none fits.
   - `room_pick = true`.
3. **Type booking**: place it per night. Prefer one room for the whole stay. Otherwise leave nights
   without a room. Don't split a new booking across rooms automatically; one room or none per
   night is the builder's call.
4. Write `booking_night`, set `booking.room_id`, and log moves.

**Price:** a type booking or a booking with unplaced nights is priced at `room_type_rate`, else
`base_rate`, plus the plan adjustment, per night. That is the rule `desiredAri` uses. A picked room
keeps today's per-room `override_rate` pricing.

### Filling empty nights later

`assignWaiting(property, type, nights)` runs in the transaction that freed capacity:

- a cancel, expiry, walk or channel cancel/modify;
- an early check-out;
- a move off a room;
- a staff unblock.

It places the oldest bookings sold as that type with empty nights in any now-free room of that
type, logging `assign`. Cross-type placement is staff-only.

### Check-in, moves, walk

- **Check-in.** `PUT /api/bookings/:id` with `status: 'checked_in'` needs tonight to have a room.
  If it hasn't, return 409 `room_required`, unless the body carries `room_id`, which runs a move for
  tonight first. The housekeeping room-ready gate checks tonight's room.
- **Moves.** `POST /api/bookings/:id/move { room_id, from?, to?, reason? }` places the booking in
  any active room (any type) for nights `[from, to)`. Those default to tonight (or arrival) through
  check-out.
  - Allowed if the room is free of other live bookings on those nights, apart from auto-assigned
    holders outside the cutoff, which get bumped.
  - The reason defaults to `upgrade`/`downgrade` by comparing room type `base_rate`, else `move`.
  - The vacated room's nights run `assignWaiting`.
  - The price is unchanged.
- **Walk.** `POST /api/bookings/:id/walk { note? }` sets `walked` and frees all nights. No rate-plan
  cancellation terms, no cancel email, and a channel cancel push like a cancel.

### Endpoints

All are property-scoped, and all have Swagger docs and MCP tools.

**Gated by `overbooking.manage`:**

- `PUT /api/overbooking/settings { enabled, max_pct, room_lock_days }`. `room_lock_days` could
  arguably be ungated, but keep one gate.
- `POST /api/overbooking/allowances { model, from, to, allowances: [{ room_type_id, date,
  allowance }] }` replaces the model allowances in `[from, to)`.
- `PUT /api/overbooking/allowances/:room_type_id/:date { manual_allowance | null }`.

**Readable by staff / any key:**

- `GET /api/overbooking?from&to[&room_type_id]` shows per night × type: rooms, sold, model
  allowance, manual allowance, cap, effective allowance, sellable, and nights without a room.
- `GET /api/overbooking/arrivals?date` shows arrivals whose first night has no room, bookings
  mid-stay with no room tonight, and free rooms by type.

**Booking endpoints:**

- `POST /api/bookings/:id/move`
- `POST /api/bookings/:id/walk`

**Booking payloads** add the sold type (`room_type_id`, name, code), `room_pick`, `nights: [{ night,
room_id, room_number }]`, and the current `room_id`/`room_number`, which may be null.

**MCP tools:**

- `set_overbooking_settings`
- `set_oversell_allowances`
- `set_oversell_override`
- `get_overbooking`
- `get_oversold_arrivals`
- `move_booking_room`
- `walk_booking`

### Code that must stop assuming one room per booking (from the 2026-11-05 recon)

- **Booking reads.** Read the type from `booking.room_type_id` and LEFT JOIN `room` on the current
  `room_id`.
  - `listBookings`/`getBooking` (`src/controllers/bookings.js:43,107`)
  - `fetchJoinedBooking` (`src/lib/roomPayments.js:42`)
  - `computeFolio` (`src/lib/folio.js:21`), plus `paymentIntentFor`'s null folio
  - `roomBaskets.js:29`
  - `roomBookingEmails.js:30`
- **Housekeeping.** `ensureJobs` (`src/lib/housekeeping.js:139-195`) and `onCheckedOut` take the
  room per date from `booking_night`. A room change mid-stay is a checkout clean of the old room
  plus an arrival prep of the new one. Nights with no room make no job.
- **Release.** `releaseAvailability` (`src/lib/roomPayments.js:50`) and the channel modify path
  work on `booking_night`.
- **Channels.** `desiredAri` uses `sellable_rooms`. `reservations.js` uses the shared helper. A
  `walked` booking pushes like a cancel.
- **Status lists.** `walked` joins the non-live statuses everywhere `cancelled`/`expired` appear:
  swagger enums, housekeeping, channels, and the reports that count cancellations, kept separate.
- **Check scripts** that insert bookings directly must write `room_type_id` and `booking_night`.

### Model feed

`ml/overbooking.py` gets a `--write` mode that posts `safe_oversell` per night × type for its window
(`from`, `to`). It must group by **`booking.room_type_id`** (as sold), and not count walked bookings.

## Constraints

- Migration on **live first (with OK), then push**. It is big:
  - new columns and tables;
  - the `room_type_id` backfill;
  - `booking_night` built from existing bookings and their closed flags.
  New code must not run on the old schema. Build `check-overbooking.js` to run the migration and
  backfill against a copy of live data locally first.
- One transaction per multi-step write. Every occupancy change refreshes `room_type_availability`
  concurrently and nudges channel sync (via the existing `refreshAvailabilityView`).
- Checklist:
  - dated migration plus `schema.sql`;
  - Swagger;
  - MCP tools;
  - `scripts/check-overbooking.js`, which refuses a remote DB;
  - `check-mcp-coverage.js` passing;
  - the existing check scripts updated and passing.

## Left to the builder

- The exclusion mechanism on `booking_night` and how "live" reaches it.
- Whether `room_type_availability` stays a materialized view or becomes a view over live counts.
- The advisory-lock key, helper names and factoring.
- The placement heuristic for type bookings (whole-stay room first).
- Cap rounding.

## Follow-on (separate task)

Fix the seeded antonio-zahara bookings (`metadata.source = 'hotel-booking-demand'`) so each
`room_type_id` matches the CSV's `reserved_room_type`. The rooms stay as they are, which gives true
"sold as A, got D" data. This writes to live OTA, so it needs Robert's OK.
