# Room Overbooking, Room Picks and Per-Night Rooms: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bookings carry a sold room type and per-night rooms. Rooms are auto-assigned, picks win
and can bump. Types can be oversold by a model allowance with a manager override, under a
per-property cap. A walked status completes the flow.

**Architecture:**
- `booking_night` (one row per booking-night, `room_id` nullable) becomes the occupancy record,
  guarded by a unique `(room_id, night)` index.
- Availability is a per-type count, served by one helper module `src/lib/roomNights.js` that
  every sales path (API, website, channels) calls.
- Per-room `room_availability` flags are **still written** on hold/release, exactly as today. Old
  and new code therefore agree during the deploy window, and staff blocks keep working. A flag
  counts as a *staff block* only when it's closed and no live `booking_night` holds that room and
  night.

**Tech Stack:** Node/Express, PostgreSQL (`pg`), `node:assert` check scripts, Python
(antonio-zahara `ml/`).

**Spec:** `docs/superpowers/specs/2026-11-05-room-overbooking-design.md`

## Global Constraints

- Every query is scoped by `req.property_id`. Dates are `YYYY-MM-DD`, and stays are `[check_in, check_out)`.
- Holding statuses are `pending_payment`, `confirmed` and `checked_in`. A `checked_out` booking
  holds only its past nights, and future nights are deleted at check-out. `cancelled`, `expired`
  and `walked` hold nothing; their `booking_night` rows are deleted.
- Multi-step writes run in one transaction. After COMMIT, call
  `roomPayments.refreshAvailabilityView()`, which also nudges channel sync.
- Permission name: `overbooking.manage`, added to `PERMISSIONS` in `src/lib/permissions.js` and
  checked with `requirePermission`.
- Defaults:
  - `property.overbooking_enabled = false`
  - `property.oversell_max_pct = 0`
  - `property.room_lock_days = 1`
- Effective allowance = `LEAST(COALESCE(manual_allowance, model_allowance), floor(oversell_max_pct/100 × active rooms of type))`.
  It is 0 when overbooking is disabled.
- Moves never change `total_price`. Refunds are manual.
- Errors go through `errorHandler`, shaped `{ error, details? }`.
- Every new route gets Swagger in `src/docs/swagger.js` and an MCP tool in `mcp-server/tools.js`.
- `node -r dotenv/config scripts/check-mcp-coverage.js` must pass.
- New check scripts start with the remote-DB refusal line used in `scripts/check-cancel-scores.js:6`.
- Live DB:
  - Migration A runs on live **with Robert's OK before the push**.
  - Migration B runs **after** the deploy is up.
  - Never push before migration A is live.

## Review Focus

1. **Concurrent last-slot bookings.** Two bookings racing for the last sellable slot of a type:
   exactly one succeeds. Tested by Task 3 `race: two concurrent bookings for last slot`.
2. **Manager lowers the allowance below what's already sold.** Sellable clamps to 0 and nothing
   is cancelled. Tested by Task 2 `allowance lowered below sold clamps to 0`.
3. **Pick over a booking that is auto-assigned but inside the cutoff, or checked in.** The pick
   is refused with 409 and the holder is untouched. Tested by Task 3 `pick refused inside cutoff`
   and `pick refused over checked-in`.
4. **Staff block on a room that also has a booking.** It isn't double-counted, and unblocking
   with no booking reopens the room. Tested by Task 2
   `block on booked room not double-counted`.
5. **A booking made by the old code during the deploy window** (no `booking_night`, NULL
   `room_type_id`). Migration B backfills it and the new code reads it. Tested by Task 1
   `backfill is idempotent and catches late rows`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrate-2026-11-05-overbooking-a.sql` | Additive: columns, tables, indexes, backfill (pre-push) |
| `src/db/migrate-2026-11-05-overbooking-b.sql` | Post-deploy: re-backfill, `room_type_id NOT NULL`, drop `booking_no_overlap` |
| `src/db/schema.sql` | End state of A + B, plus the view change |
| `src/lib/roomNights.js` (new) | Counts, hold/release/assign/move/bump, `current room` sync. The single writer of `booking_night` |
| `src/lib/overbooking.js` (new) | Settings, allowances, effective allowance, cap |
| `src/controllers/overbooking.js` + `src/routes/overbooking.js` (new) | Overbooking endpoints |
| `src/controllers/bookings.js` | `createBooking` through `roomNights`, cancel/check-in/check-out changes, `moveBooking`, `walkBooking` |
| `src/lib/roomPlacement.js` | Keeps `stayNights`. `placeBooking` is deleted once its callers move (Task 6) |
| `src/lib/roomPayments.js` | `fetchJoinedBooking` LEFT JOIN plus nights; `releaseAvailability` → `roomNights.releaseNights` |
| `src/lib/channels/desired.js`, `reservations.js` | Sellable counts; new/modify/cancel through `roomNights` |
| `src/lib/folio.js`, `roomBaskets.js`, `roomBookingEmails.js`, `housekeeping.js` | Stop assuming a room |
| `scripts/check-overbooking.js` (new) | All new behaviour, run against the local DB |
| `antonio-zahara/ml/overbooking.py` | Group by sold type; `--write` |

---

### Task 1: Migration A + schema

**Files:**
- Create: `src/db/migrate-2026-11-05-overbooking-a.sql`, `src/db/migrate-2026-11-05-overbooking-b.sql`
- Modify: `src/db/schema.sql:315-347` (booking block), `:468-484` (view), property table
- Test: `scripts/check-overbooking.js` (create, section `migration`)

**Interfaces:**
- Produces, in migration A:
  - `booking.room_type_id UUID REFERENCES room_type(id)` (nullable in A)
  - `booking.room_pick BOOLEAN NOT NULL DEFAULT false`
  - `booking_night(booking_id UUID REFERENCES booking(id) ON DELETE CASCADE, property_id UUID NOT NULL, night DATE NOT NULL, room_id UUID REFERENCES room(id), PRIMARY KEY (booking_id, night))`
  - `CREATE UNIQUE INDEX idx_booking_night_room ON booking_night(room_id, night) WHERE room_id IS NOT NULL`
  - `idx_booking_night_property_night ON booking_night(property_id, night)`
  - `booking_room_move(id, property_id, booking_id, night_from DATE, night_to DATE, from_room_id, to_room_id, reason VARCHAR(10) CHECK (reason IN ('assign','bump','upgrade','downgrade','move','release')), moved_at TIMESTAMPTZ DEFAULT now(), moved_by VARCHAR(255))`
  - `room_type_oversell(property_id, room_type_id, date, model_allowance INT NOT NULL DEFAULT 0 CHECK ≥0, manual_allowance INT CHECK ≥0, model VARCHAR(100), updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (room_type_id, date))`
  - `property.overbooking_enabled`, `oversell_max_pct NUMERIC(5,2)`, `room_lock_days INT`, with the defaults above
- Backfill SQL, reused verbatim by B:
  - `UPDATE booking b SET room_type_id = r.room_type_id FROM room r WHERE r.id = b.room_id AND b.room_type_id IS NULL`
  - Insert `booking_night` rows from `generate_series(check_in, check_out - 1)` for bookings in
    holding statuses (`checked_out` past nights included) with `ON CONFLICT DO NOTHING`
- B:
  - re-run both backfills;
  - `ALTER COLUMN room_type_id SET NOT NULL`;
  - `ALTER TABLE booking DROP CONSTRAINT booking_no_overlap`.
- `walked` needs no DDL change: `status` is a free `VARCHAR(20)`.

- [ ] **Step 1: Write the failing check.** Section `migration` in `scripts/check-overbooking.js`, following the harness in `scripts/check-cancel-scores.js` (throwaway properties, cleanup in `finally`):

```js
// backfill is idempotent and catches late rows
await pool.query(`INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price) VALUES ($1,$2,$3,'2030-01-01','2030-01-04',300)`, [P, g, room1]); // old-code row
await runSql('src/db/migrate-2026-11-05-overbooking-b.sql');
await runSql('src/db/migrate-2026-11-05-overbooking-b.sql'); // idempotent
const late = await one(`SELECT room_type_id FROM booking WHERE property_id=$1`, [P]);
assert.equal(late.room_type_id, typeA);
assert.equal((await one(`SELECT count(*)::int n FROM booking_night WHERE room_id=$1`, [room1])).n, 3);
```

`runSql(path)` reads the file and runs `pool.query`. B must be idempotent: use `DROP CONSTRAINT IF EXISTS` and guard `SET NOT NULL`.

- [ ] **Step 2: Run** `node -r dotenv/config scripts/check-overbooking.js`. Expected: FAIL (`booking_night` does not exist).
- [ ] **Step 3: Write migrations A and B, and update `schema.sql`** to the A+B end state. Leave the view for Task 2.
- [ ] **Step 4: Apply A locally only** with `psql "$DATABASE_URL" -f src/db/migrate-2026-11-05-overbooking-a.sql`. **Not** `run-migration.js`, which also hits live. Then run the check. Expected: `ok   migration`.
- [ ] **Step 5: Commit** `git commit -m "Overbooking: migrations A/B (booking_night, sold type, allowances, settings)"`.

### Task 2: Counts and availability view

**Files:**
- Create: `src/lib/roomNights.js`, `src/lib/overbooking.js`
- Modify: `src/db/schema.sql` view, `src/db/migrate-2026-11-05-overbooking-a.sql` (append the view rebuild), `src/controllers/availability.js:93-110` (search)
- Test: `scripts/check-overbooking.js`, section `counts`

**Interfaces:**
- Produces in `src/lib/overbooking.js`:
  - `settings(db, propertyId) -> { enabled, max_pct, room_lock_days }`
  - `effectiveAllowances(db, propertyId, roomTypeId|null, nights: string[]) -> Map<"typeId|night", { model, manual, cap, effective }>`
- Produces in `src/lib/roomNights.js`:
  - `HOLDING = ['pending_payment','confirmed','checked_in']`
  - `typeCounts(db, propertyId, roomTypeId|null, nights) -> Map<"typeId|night", { rooms, blocked, sold, allowance, sellable, unplaced }>`
    - `rooms` = active rooms.
    - `blocked` = closed flags on active rooms with no live `booking_night` for that room and night.
    - `sold` = live `booking_night` rows (any room or none) whose booking's `room_type_id` = type.
    - `unplaced` = the `sold` rows with `room_id IS NULL`.
    - `sellable = max(0, rooms − blocked − sold + allowance)`.
- View `room_type_availability`: rebuild it with the same unique index. Keep `total_rooms`,
  `available_rooms` (= rooms − blocked − nights held by any booking in a room of that type) and
  `min_rate`, and add `sold`, `oversell_allowance` and `sellable_rooms`. `total_rooms` now counts
  **active** rooms only. Search uses `HAVING MIN(rta.sellable_rooms) > 0` and returns
  `min_available` from `sellable_rooms`.

- [ ] **Step 1: Write the failing checks** (section `counts`) for 2 active rooms of type A and 1 inactive:

```js
// no bookings, disabled
assert.deepEqual(pick(await typeCounts(pool, P, A, ['2030-02-01'])), { rooms: 2, blocked: 0, sold: 0, allowance: 0, sellable: 2, unplaced: 0 });
// enable, cap 50% => 1; model 3 => effective 1
await pool.query(`UPDATE property SET overbooking_enabled=true, oversell_max_pct=50 WHERE id=$1`, [P]);
await pool.query(`INSERT INTO room_type_oversell (property_id, room_type_id, date, model_allowance) VALUES ($1,$2,'2030-02-01',3)`, [P, A]);
assert.equal(get('2030-02-01').sellable, 3);
// manual 0 overrides model
// allowance lowered below sold clamps to 0  (insert 3 sold nights, manual 0 => sellable 0, not -1)
// block on booked room not double-counted  (flag closed + booking_night on same room/night => blocked 0, sold 1)
// disabled property => allowance 0 even with rows present
```

  Also a search check: `searchAvailability` returns the type when `sellable_rooms > 0` even though `available_rooms = 0`.
- [ ] **Step 2: Run.** Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `settings`, `effectiveAllowances`, `typeCounts` (one SQL per call, no per-night loops in JS), the view rebuild (in A and `schema.sql`) and the search change.
- [ ] **Step 4: Run.** Expected: `ok   counts`.
- [ ] **Step 5: Commit** `"Overbooking: per-type counts, allowance, view + search use sellable"`.

### Task 3: Hold a stay: auto-assign, pick, bump, oversell (direct bookings)

**Files:**
- Modify: `src/lib/roomNights.js`, `src/controllers/bookings.js:131-323` (`createBooking`)
- Test: `scripts/check-overbooking.js`, section `hold`

**Interfaces:**
- Consumes: `typeCounts`, `settings`.
- Produces:
  - `lockType(client, roomTypeId)`, which is `pg_advisory_xact_lock(hashtext('rt:'||roomTypeId))`.
  - `holdStay(client, { propertyId, bookingId, roomTypeId, nights, pickRoomId|null, movedBy|null }) -> { placedNights: string[], unplacedNights: string[], bumped: uuid[] }`.
    It throws `{ status: 409, message }` when sellable < 1 on any night (message `No rooms of this
    type available for the requested dates`) or when a pick is refused (`Room not available on
    <night>`).
  - `syncCurrentRoom(client, bookingId)` sets `booking.room_id` to tonight's room (property-local
    today) once the stay has started, otherwise the first night's room, or NULL.
  - `logMove(client, row)`.
- Rules:
  - **Picks** go to that room on every night. A night held by another booking is allowed only if
    the holder has `room_pick = false`, its status is not `checked_in`, and its `check_in` is more
    than `room_lock_days` days after the property-local today. Otherwise refuse.
  - **Bumped holders** are re-placed on those nights into another room of their **sold** type that
    is free on all of them. If none fits, they stay unplaced on those nights. Log `bump`.
  - **Type bookings** go to the first active room of the type (by `room_number`) that is free on
    every night. If none, every night stays unplaced. Never split automatically.
  - **Flags:** close `room_availability` for every placed (room, night) and reopen for every
    vacated one, so the old code stays consistent.
- `createBooking` changes:
  - It inserts the booking first, with `room_id NULL`, `room_type_id` and `room_pick = !!room_id`,
    then calls `holdStay`, then `syncCurrentRoom`.
  - Price per night: picked room → `room_availability.override_rate` of that room, else type rate,
    else base. Type booking → type rate, else base. Then the plan adjustment. The rest of the
    validation, plan, card and email logic is unchanged.
  - The `placeBooking` call is removed from this file.

- [ ] **Step 1: Write the failing checks**, calling `createBooking` through `call()`:
  - `type booking auto-assigns`: room set, `room_pick` false, 2 nights in `booking_night`, flags closed.
  - `pick bumps auto-assigned`: B1 auto-assigned to room 1 (check_in today+10). Pick room 1 for the
    same nights → 201. B1 is now in room 2 and a `bump` row is logged.
  - `pick refused inside cutoff`: holder's check_in = today+1, `room_lock_days` 1 → 409, holder unchanged.
  - `pick refused over checked-in`: 409.
  - `oversold booking has no room`: both rooms taken, allowance 1 → 201, `room_id` null, nights
    unplaced. The next one → 409.
  - `race: two concurrent bookings for last slot`: `Promise.all` of two `createBooking` calls →
    exactly one 201 and one 409.
  - `type booking priced at type rate`: an override_rate on the room is ignored for a type booking
    and applied for a pick.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `lockType`, `holdStay`, `syncCurrentRoom`, `logMove` and the `createBooking` changes. Lock order: call `lockType` on the sold type first, then on any bumped holder's type in ascending uuid order.
- [ ] **Step 4: Run** the `hold` section, plus `node -r dotenv/config scripts/check-rate-plans.js` and `check-room-baskets.js`. Expected: all ok.
- [ ] **Step 5: Commit** `"Overbooking: holdStay (auto-assign, pick, bump, oversell) in createBooking"`.

### Task 4: Release and fill empty nights (cancel, expire, early check-out)

**Files:**
- Modify: `src/lib/roomNights.js`, `src/lib/roomPayments.js:50` (`releaseAvailability`) and `:328` (expire), `src/controllers/bookings.js` (`cancelBooking`, `updateBooking` check-out)
- Test: section `release`

**Interfaces:**
- Produces:
  - `releaseNights(client, booking, fromNight = null)` deletes the booking's `booking_night`
    rows (all, or `night >= fromNight`), reopens the flags it held, and then calls `assignWaiting`
    for each affected room type and night.
  - `assignWaiting(client, propertyId, roomTypeId, nights)` locks the type, then for live bookings
    sold as the type with unplaced nights among `nights`, oldest `created_at` first, puts each
    booking's unplaced nights into one room of the type free on all of them. It logs `assign` and
    calls `syncCurrentRoom`.
- `roomPayments.releaseAvailability(client, booking)` becomes a thin call to
  `roomNights.releaseNights(client, booking)`, keeping its name so the existing callers keep working.
- Check-out (status → `checked_out`) runs `releaseNights(client, booking, propertyToday)` in a
  transaction, then refreshes the view.

- [ ] **Step 1: Write the failing checks.**
  - `cancel frees room and assigns waiting`: an oversold booking gets the cancelled room and logs `assign`.
  - `early check-out frees future nights only`: past nights are kept, future nights are gone.
  - `expire releases`: run the existing expiry path on a `pending_payment` booking and its nights are gone.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the section plus `check-rate-plans.js`. Expected: ok.
- [ ] **Step 5: Commit** `"Overbooking: release nights, assign waiting bookings, early check-out"`.

### Task 5: Move, check-in gate, walk

**Files:**
- Modify: `src/lib/roomNights.js`, `src/controllers/bookings.js`, `src/routes/bookings.js`
- Test: section `move`

**Interfaces:**
- Produces:
  - `moveNights(client, booking, { roomId, from, to, reason|null, movedBy }) -> { bumped }`.
    `from` defaults to max(check_in, today), `to` to check_out. The room may be any active room of
    the property. Nights held by others follow the bump rules from Task 3. Default reason is
    `upgrade`/`downgrade` by comparing the room types' `base_rate` with the sold type's, else `move`.
    Vacated rooms run `assignWaiting`, and `total_price` is never touched.
  - Route `POST /api/bookings/:id/move` (`staffOrFullKey`) `{ room_id, from?, to?, reason? }` →
    200 with the joined booking. Reason must be one of `upgrade|downgrade|move` if given.
  - Route `POST /api/bookings/:id/walk` (`staffOrFullKey`) `{ note? }` sets status `walked`, puts
    `note` in `metadata.walk_note`, releases all nights, sends **no** email and applies no terms,
    publishes the status change, and calls `channels` cancel push via the existing sync nudge.
    Only `confirmed`/`pending_payment` may be walked; anything else → 409.
- `updateBooking` → `checked_in`:
  - If tonight has no room: with `body.room_id`, run `moveNights` for tonight first; without it →
    409 `{ error: 'room_required' }`.
  - The housekeeping gate reads tonight's room from `booking_night`.
  - `walked` joins the `pending_payment`/`expired` "set by system" refusal list in
    `updateBooking:331` (use `/walk`).

- [ ] **Step 1: Write the failing checks.**
  - `move upgrade logs reason`, `move keeps price`.
  - `check-in without room → 409 room_required`.
  - `check-in with room_id for tonight only`: tonight is placed and later nights stay unplaced.
  - `walk frees nights and assigns waiting`, `walk refused on checked_in`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: ok.
- [ ] **Step 5: Commit** `"Overbooking: move endpoint, check-in room_required, walked status"`.

### Task 6: Channels

**Files:**
- Modify: `src/lib/channels/desired.js:32-35`, `src/lib/channels/reservations.js:41-140`, `src/lib/roomPlacement.js` (delete `placeBooking`)
- Test: `scripts/check-channels.js` (update), section `channels` in `check-overbooking.js`

**Interfaces:**
- `desiredAri`: replace the `free` query with `typeCounts(db, property_id, null, dates)` →
  `available = sellable`. Trims and stop-sell apply on top as now.
- `handleNew`: insert the booking (`room_type_id` = mapping type), then `holdStay` with no pick.
  A 409 from `holdStay` → `{ outcome: 'rejected', reason: 'no room available' }`, as today.
- `handleModify`: `releaseNights(client, booking)`, update the dates, then `holdStay`.
- `handleCancel`: `releaseNights`.
- `IN_HOUSE` and the cancelled checks also treat `walked` as closed.

- [ ] **Step 1: Write the failing check** `channel push includes allowance`: an enabled property with allowance 1 and every room sold → `desiredAri` available = 1. Update any `check-channels.js` assertions that read `room_availability` flags directly so they read `booking_night`.
- [ ] **Step 2: Run** both scripts. Expected: FAIL.
- [ ] **Step 3: Implement**, then delete `placeBooking` (grep confirms there are no callers left).
- [ ] **Step 4: Run** `check-channels.js` and `check-overbooking.js`. Expected: ok.
- [ ] **Step 5: Commit** `"Overbooking: channels sell sellable_rooms and hold via roomNights"`.

### Task 7: Readers that assumed one room

**Files:**
- Modify:
  - `src/controllers/bookings.js:43,50,107` (list, count, detail)
  - `src/lib/roomPayments.js:31-47` (`fetchJoinedBooking`), `:155` (`paymentIntentFor` null folio → 404)
  - `src/lib/folio.js:21`, `src/lib/roomBaskets.js:29`, `src/lib/roomBookingEmails.js:30`
  - `src/lib/housekeeping.js:139-195, 301-317`
- Test: section `readers`, plus `check-housekeeping.js`, `check-room-baskets.js`, `check-cancel-scores.js`, `check-core-mcp.js`

**Interfaces:**
- Booking payloads:
  - `room_type_*` come from `booking.room_type_id` (sold type), and room fields from `LEFT JOIN room r ON r.id = b.room_id`.
  - Add `room_pick` and `nights: [{ night, room_id, room_number }]` via a `NIGHTS_SQL` constant in
    `roomPayments.js`, next to `CANCEL_SCORE_SQL`, used by list, detail and live.
- Folio, baskets and emails: same join change. The room number may be null; emails print the room
  type when there is no room yet.
- Housekeeping `ensureJobs`:
  - Rewrite departure, stayover and arrival selection off `booking_night`.
  - Checkout job: the room held on `date − 1` whose holder holds no night on `date` in that room.
  - Stayover: the room held on both `date − 1` and `date` by the same booking.
  - Arrival: the room held on `date` with no hold on `date − 1` (by that booking).
  - Unplaced nights make no jobs.
  - `onCheckedOut` takes the room held on `today − 1`.

- [ ] **Step 1: Write the failing checks.**
  - `oversold booking visible in list/detail/live`: `room_id` null, sold type present, `nights` populated.
  - `folio works with no room`.
  - `emails render with no room` (call the email builder with the fake sender used in `check-rate-plans.js`).
  - `split stay makes checkout + arrival jobs on the move day`.
  - `ensureJobs survives unplaced bookings`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `check-overbooking.js`, `check-housekeeping.js`, `check-room-baskets.js`, `check-cancel-scores.js`, `check-core-mcp.js` and `check-review-requests.js`. Fix fixtures that insert bookings directly: add `room_type_id` and the `booking_night` rows through a tiny shared fixture `insertBooking(db, {...})` in `scripts/lib/fixtures.js`. Expected: all ok.
- [ ] **Step 5: Commit** `"Overbooking: payloads, folio, emails, baskets, housekeeping read sold type + nights"`.

### Task 8: Overbooking endpoints

**Files:**
- Create: `src/controllers/overbooking.js`, `src/routes/overbooking.js`
- Modify: `src/app.js` (mount `/api/overbooking`; find the mount list with `grep -n "app.use('/api" src/app.js`), `src/lib/permissions.js`
- Test: section `endpoints`

**Interfaces** (all scoped to `req.property_id`, all mounted behind `authenticateOrApiKey`):
- `PUT /settings` (`requirePermission('overbooking.manage')`) `{ enabled?: bool, max_pct?: 0-100, room_lock_days?: int 0-30 }` → the settings.
- `POST /allowances` (manage) `{ model: string 1-100, from, to, allowances: [{ room_type_id, date, allowance: int ≥0 }] }`.
  - Max 5000 rows, and dates must lie in `[from, to)`, else 400.
  - In one transaction: set `model_allowance = 0, model = $model` for all of the property's rows
    in `[from, to)`, then upsert the given rows.
  - `manual_allowance` is untouched.
  - Room types from another property → 400 listing them.
  - Returns `{ saved }`.
- `PUT /allowances/:room_type_id/:date` (manage) `{ manual_allowance: int ≥0 | null }`.
- `GET /?from&to[&room_type_id]` (`staffOrFullKey`) returns rows `{ room_type_id, date, rooms, sold, model_allowance, manual_allowance, cap, effective_allowance, sellable, unplaced }` from `typeCounts` + `effectiveAllowances`. The range is at most 400 days.
- `GET /arrivals?date` (`staffOrFullKey`) returns `{ unplaced_arrivals: [booking], unplaced_in_house: [booking], free_rooms: [{ room_type_id, rooms: [{ id, room_number }] }] }`.
- Every write refreshes the view after commit.

- [ ] **Step 1: Write the failing checks.**
  - `scoped key without permission → 403`, `scoped key with overbooking.manage → 200` (go through `hasPermission` by setting `req.auth_method='api_key'` and `req.api_key.permissions`).
  - `model post replaces range`: a night omitted from the 2nd post drops to 0 while its manual value is kept.
  - `manual null hands back to model`.
  - `other property's room type → 400`.
  - `arrivals lists unplaced guest and free rooms`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `check-overbooking.js` and `check-permissions.js`. Expected: ok.
- [ ] **Step 5: Commit** `"Overbooking: settings, allowances (model/manual), overview and arrivals endpoints"`.

### Task 9: Swagger + MCP tools

**Files:**
- Modify: `src/docs/swagger.js`, `mcp-server/tools.js`
- Test: `scripts/check-mcp-coverage.js`

**Interfaces:**
- **Swagger:** the five `/api/overbooking` routes, `POST /api/bookings/{id}/move` and `/walk`. The
  booking schema gains `room_type_id` (sold), `room_pick`, `nights`, nullable `room_id`, and
  `walked` in the status enum. Check-in documents `room_id` and the `room_required` 409.
- **MCP tools**, each through `apiRequest`, following the existing booking tools' style:
  - `set_overbooking_settings`
  - `set_oversell_allowances`
  - `set_oversell_override`
  - `get_overbooking`
  - `get_oversold_arrivals`
  - `move_booking_room`
  - `walk_booking`
  - and `update_booking` gains `room_id` in its description for check-in.

- [ ] **Step 1: Run** `node -r dotenv/config scripts/check-mcp-coverage.js`. Expected: FAIL, listing the 7 new routes.
- [ ] **Step 2: Add Swagger + tools.**
- [ ] **Step 3: Run** coverage. Expected: pass. Then open `/api/docs` locally (`npm run dev`) and check the new tags render.
- [ ] **Step 4: Commit** `"Overbooking: swagger + MCP tools"`.

### Task 10: Full local run, then live (needs Robert's OK)

- [ ] **Step 1:** Run every `scripts/check-*.js` that touches bookings: overbooking, channels, housekeeping, rate-plans, room-baskets, cancel-scores, core-mcp, review-requests, permissions, cash-payments, multi-property. Expected: all ok.
- [ ] **Step 2: Rehearse A on a copy of live data.** `pg_dump "$DATABASE_URL_LIVE"` into a scratch local DB, run A there, and compare:
  - `count(*)` of `booking_night` against the sum of holding nights;
  - zero bookings with NULL `room_type_id` among bookings that have a room.

  Report the numbers to Robert.
- [ ] **Step 3: Ask Robert's OK**, then run A on live: `node scripts/run-migration.js src/db/migrate-2026-11-05-overbooking-a.sql`. Local is already applied and A is idempotent.
- [ ] **Step 4: Push `main`** and wait for the Render deploy to go live.
- [ ] **Step 5:** Run B with `node scripts/run-migration.js src/db/migrate-2026-11-05-overbooking-b.sql`, then smoke `GET /api/bookings` and `GET /api/overbooking?from&to` on live with the antonio-zahara key.
- [ ] **Step 6:** Update memory (`project_overbooking_state.md`).

### Task 11: Model feed (antonio-zahara repo)

**Files:**
- Modify: `C:\Users\robert\source\repos\antonio-zahara\ml\overbooking.py`

**Interfaces:**
- Consumes: `POST /api/overbooking/allowances`.
- Group by `b['room_type_id']` (sold type; the payload now carries it). Rooms come from `/api/rooms` as now.
- Skip `walked` bookings. Unscored ones count as arriving.
- `--write` posts `{ model: 'safe-oversell-95', from: start, to: start+days, allowances: [...] }` for every night × active type, including zeros, in one call, and prints `saved`.

- [ ] **Step 1:** Extend the `__main__` asserts with a pure `allowance_rows(nights, rooms, start, days)` function returning the post body rows. Assert that a type with no bookings yields an allowance of 0 for every night.
- [ ] **Step 2:** Run `python ml/overbooking.py` (dry, read-only against live). It prints as before.
- [ ] **Step 3:** Implement `--write`. **Only run it against live once Robert has switched overbooking on for the property.**
- [ ] **Step 4:** Commit in antonio-zahara: `"ml: overbooking posts allowances to OTA (--write)"`.

### Follow-on (separate, needs OK, not in this plan)

Re-type the seeded `hotel-booking-demand` bookings to `reserved_room_type`.
