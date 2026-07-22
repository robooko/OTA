# Book by Room Type (Race-Safe Room Selection) — Design

## Context

`POST /api/bookings` currently requires a specific `room_id`. A site-side caller that wants to let a guest book "a Bungalow" rather than a specific unit has to separately list rooms of that type (`GET /api/rooms?room_type_id=...`) and probe each one's availability to find a free one — a multi-request dance with a genuine race condition: two guests hitting the same "found free room" candidate at the same time can both proceed to book it, since nothing serializes that decision.

Investigating this also surfaced a related, pre-existing bug: even today's exact-`room_id` path has no protection against the same race. `createBooking` reads `room_availability` and does a manual `SELECT` for overlapping confirmed bookings, then later `INSERT`s — all under default `READ COMMITTED` isolation, with no locking in between. Two concurrent requests for the *same* `room_id` and overlapping dates can both pass every check before either commits, producing a double-booking. This isn't hypothetical under any real concurrent load.

**Goal:** let `POST /api/bookings` accept `room_type_id` as an alternative to `room_id`, picking and reserving the first available room of that type atomically — and close the underlying race for both the existing `room_id` path and the new `room_type_id` path, using a database-enforced constraint rather than application-level locking.

## Design

### Schema: exclusion constraint

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out) WITH &&
  )
  WHERE (status <> 'cancelled');
```

- `btree_gist` is required because the exclusion constraint mixes an equality column (`room_id`, a `UUID`) with a range-overlap column (`daterange`) in one GiST index — `btree_gist` supplies the GiST operator class for the equality half. It's a standard, trusted Postgres contrib extension, available on Render's managed Postgres.
- `daterange(check_in, check_out)` defaults to `[)` bounds (inclusive start, exclusive end) — matching the check-out-exclusive convention already used everywhere else in this codebase (`WHERE date >= check_in AND date < check_out`).
- `WHERE (status <> 'cancelled')`, not `= 'confirmed'`: a `checked_in` or `checked_out` booking still represents the room being occupied for those dates and must still block new overlapping bookings. Only `cancelled` frees the room. (`cancelBooking` already sets `status = 'cancelled'` and separately restores `room_availability` — this constraint doesn't change that flow, it just stops enforcing the exclusion once a booking is cancelled.)
- This constraint makes overlapping non-cancelled bookings for the same room **impossible at the database level**, regardless of application-level races — it doesn't just narrow the race window, it closes it.
- Migration precondition: before `ADD CONSTRAINT` (which validates all existing rows), confirm no existing overlapping non-cancelled bookings exist in either database. Expected to be none, but must be checked — the constraint will fail loudly (and safely — it's all-or-nothing) if any are found.

### Controller: `createBooking`

**Validation** — replace the current `if (!guest_id || !room_id || !check_in || !check_out)` with a check requiring `guest_id`, `check_in`, `check_out`, and **exactly one** of `room_id` / `room_type_id`:
- Neither provided, or both provided → `400 { error: "Provide exactly one of room_id or room_type_id" }`.

**`room_id` path (existing behavior, simplified)**:
- Room-exists/active check and the per-date `room_availability` check stay exactly as they are today.
- The manual "check no overlapping confirmed booking" `SELECT` is **removed** — it's now redundant. Instead, the `INSERT` itself is the source of truth: if it raises Postgres error code `23P01` (`exclusion_violation`), catch it in the function's existing top-level `catch` block, issue a full `ROLLBACK` (no savepoint needed here — there's only one candidate room, so there's nothing to retry within the transaction), and return the same `409 { error: "Room already booked for this period" }` the old manual check used to produce. Net effect: less code, and the response is now correct even when the manual check would have raced (two concurrent requests for the same room/dates — previously both could pass the check; now the database guarantees only one `INSERT` succeeds and the other cleanly gets `409`).

**`room_type_id` path (new)**:
1. Validate the room type belongs to the caller's property (`404` if not found) — same pattern `POST /api/rooms` already uses for validating `room_type_id`.
2. Fetch active rooms of that type, ordered by `room_number`.
3. For each candidate room, in order, within the *same* transaction:
   - `SAVEPOINT attempt`
   - Run the same per-date `room_availability` check used by the `room_id` path (all nights must be `is_available = true` for this specific candidate — reusing that candidate's own `override_rate`s to compute `total_price`, since different rooms of the same type can have different overrides).
   - If any date isn't available: `ROLLBACK TO SAVEPOINT attempt`, move to the next candidate (no DB error involved — this is just today's ordinary "not available" case for this specific room).
   - If all dates check out, attempt the `INSERT`. On success: `RELEASE SAVEPOINT attempt`, return `201` with the booking (its `room_id` tells the caller which room was actually assigned).
   - If the `INSERT` raises `23P01` (a concurrent request grabbed this exact room/dates between our check and our insert): `ROLLBACK TO SAVEPOINT attempt`, move to the next candidate — this is the actual race-safety net, not just a theoretical one.
4. If every candidate is exhausted without success: roll back the whole transaction, `409 { error: "No rooms of this type available for the requested dates" }`.

The `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` pattern is required, not optional: Postgres aborts an entire transaction on the first unhandled error within it (every subsequent query fails with "current transaction is aborted" until a `ROLLBACK`). Savepoints let this loop recover from one candidate's failure and keep trying the next, inside one transaction, without re-doing the guest/room-type validation each time.

**Out of scope, left as-is**: the per-date `is_available` check itself isn't hardened by this change (a concurrent *admin* action marking a date unavailable mid-booking-attempt is a separate, much lower-frequency race than guest-vs-guest double-booking, and wasn't part of what was reported here).

## API surface

`POST /api/bookings` body: `room_id` stays as-is; new optional `room_type_id` (mutually exclusive with `room_id`, both `format: uuid`). Response shape is unchanged — the assigned `room_id` is always present in the returned booking, whichever path was used.

## Documentation (Swagger)

Add `room_type_id: { type: 'string', format: 'uuid' }` to the `POST /api/bookings` request schema, with a description noting it's an alternative to `room_id` (exactly one required).

## Verification

1. Before the migration: query both databases for any existing overlapping non-cancelled bookings per room — confirm none exist.
2. Apply the migration locally and to `otadb`; confirm the constraint exists and both DBs still have all prior rows intact.
3. `room_id` path: existing booking creation still works (`201`); booking the same room/dates twice now returns `409` from the constraint-catch path instead of the old manual-check path (same response shape).
4. `room_type_id` path: book BBYC's `Bungalow` type for a date range with several rooms free — confirm `201` and that the returned `room_id` is one of BBYC's active bungalows.
5. Exhaustion case: book all of a type's rooms for the same date range one at a time via `room_type_id`, then attempt one more — confirm `409 "No rooms of this type available for the requested dates"`.
6. Validation: `room_id` and `room_type_id` both provided → `400`; neither provided → `400`.
7. Repeat the key checks (3-4) against live `otadb`/Render once local passes and the change is pushed.
