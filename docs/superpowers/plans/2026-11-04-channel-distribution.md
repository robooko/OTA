# Channel distribution (rooms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A channel-agnostic distribution core for rooms (desired-state ARI diffed against a per-channel last-sent snapshot, per-channel caps/stop-sell, inbound reservations, drift report) with a built-in `test` adapter, provable end to end on Bloody Mary.

**Architecture:** For each channel the core computes the *desired* grid (mapping × date → available, rate, stop_sell) from live OTA tables and diffs it against `channel_ari` (what we last sent + ack). The diff is what `sync` pushes through the channel's adapter and what `drift` reports. A 60 s job plus a debounced nudge from the view-refresh helper drives sync; correctness never depends on the nudge. Inbound reservations go through one core function that books via logic shared with `createBooking`.

**Tech Stack:** Node.js / Express / PostgreSQL (`pg`), `zod` MCP tools, Swagger object in `src/docs/swagger.js`, `node:assert` check scripts.

**Spec:** `docs/superpowers/specs/2026-11-04-channel-distribution-design.md`

## Global Constraints

- Every query scoped by `property_id`; a channel belongs to one property. 404 for another property's channel.
- Dates `YYYY-MM-DD`; stays `[check_in, check_out)`. Trim ranges are **inclusive** `[date_from, date_to]`.
- Errors via `errorHandler` / `res.status(...).json({ error, details? })`, 400 / 404 / 409 / 500.
- All channel routes: `staffOrFullKey` (`[authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')]`, as in `src/routes/availability.js`).
- Multi-step writes in one transaction; after commit call `roomPayments.refreshAvailabilityView()`.
- A channel failure never fails or rolls back an OTA booking/edit.
- Rate parity: one rate per mapping per date for every channel. Advertised rate = `room_type_rate.rate` else `room_type.base_rate`, then `applyAdjustment(rate, plan.adjustment_pct)` when the mapping has a plan. Per-room `override_rate` is **not** advertised.
- Available = count of `room_availability.is_available` nights of rooms with `room.status = 'active'` (do **not** read `room_type_availability.available_rooms`), then `min(…, cap)`, then 0 if stop-sell.
- `channel.horizon_days` default 365, 1–548. "Today" = `CURRENT_DATE` (same as `availabilitySeeder`).
- Channel bookings: status `confirmed`, no Stripe, no OTA guest emails, `total_price` = channel's total.
- `collect`: channel default `hotel` | `channel`, overridable per reservation. `channel` ⇒ a `payment` row (`method 'channel'`, `status 'completed'`, `paid_at now()`).
- Check script refuses a remote DB: `if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');`
- No inbound webhook route in v1 (no adapter needs it).
- Deploy: live migration (with Robert's OK) **before** pushing `main`.

## Review Focus

1. **Job and nudge sync the same channel at once** → exactly one push of the diff, never double-sent or a lost ack (Task 3 test "concurrent syncs push once").
2. **Out-of-service room** (`room.status <> 'active'` with open nights) → not counted for channels (Task 2 test "inactive rooms not counted").
3. **Reservation with an unmapped room/rate code** → logged `rejected` ("unknown room/rate code"), no booking, no throw (Task 5 test).
4. **Reservation currency ≠ property currency** → `rejected` ("currency mismatch") (Task 5 test).
5. **modify/cancel for an unknown ref, or a booking already checked_in/checked_out** → `rejected` with reason, booking untouched (Task 5 test).

---

## File structure

- Create `src/db/migrate-2026-11-04-channels.sql`; modify `src/db/schema.sql` (same DDL).
- Create `src/lib/channels/index.js` — adapter registry `ADAPTERS`.
- Create `src/lib/channels/test.js` — the test adapter.
- Create `src/lib/channels/desired.js` — desired grid.
- Create `src/lib/channels/sync.js` — diff, push, snapshot, pausing/closing, job, nudge.
- Create `src/lib/channels/reservations.js` — `receiveReservation`.
- Create `src/lib/roomPlacement.js` — room picking shared by `createBooking` and inbound.
- Create `src/controllers/channels.js`, `src/routes/channels.js`; mount `/api/channels` in `src/app.js`.
- Modify `src/controllers/bookings.js` (use `roomPlacement`, channel cancel guard, `channel_id` list filter), `src/lib/roomPayments.js` (nudge), `src/controllers/availability.js` + `src/controllers/roomTypes.js` (use the helper), `src/lib/ably.js`, `src/server.js`, `src/docs/swagger.js`, `mcp-server/tools.js`.
- Create `scripts/check-channels.js` (harness copied from `scripts/check-rate-plans.js`: throwaway properties + api keys, `app.listen(0)`, `api()` helper, cleanup in `finally`).

---

### Task 1: Schema

**Files:**
- Create: `src/db/migrate-2026-11-04-channels.sql`
- Modify: `src/db/schema.sql` (after the `booking` table / its indexes; `ALTER` folded into the `booking` CREATE)
- Test: `scripts/check-channels.js`

**Interfaces:**
- Produces tables:
  - `channel (id uuid pk default gen_random_uuid(), property_id uuid not null → property, adapter varchar(30) not null, name varchar(100) not null, status varchar(10) not null default 'active' check in ('active','pausing','paused'), horizon_days int not null default 365 check between 1 and 548, collect varchar(10) not null default 'hotel' check in ('hotel','channel'), config jsonb not null default '{}', created_at timestamptz default now())`
  - `channel_mapping (id uuid pk, property_id uuid not null, channel_id uuid not null → channel on delete cascade, room_type_id uuid not null → room_type, rate_plan_id uuid null → rate_plan, room_code varchar(64) not null, rate_code varchar(64) not null, status varchar(10) not null default 'active' check in ('active','closing'), unique (channel_id, room_code, rate_code))`
  - `channel_trim (id uuid pk, property_id uuid not null, channel_id uuid not null → channel on delete cascade, room_type_id uuid null → room_type, date_from date not null, date_to date not null, max_available int null check >= 0, stop_sell boolean not null default false, check (date_from <= date_to), check (max_available is not null or stop_sell))`
  - `channel_ari (mapping_id uuid not null → channel_mapping on delete cascade, date date not null, available int not null, rate numeric(10,2) not null, stop_sell boolean not null, status varchar(10) not null check in ('ok','failed'), error text, sent_at timestamptz not null default now(), primary key (mapping_id, date))`
  - `channel_reservation_log (id uuid pk, property_id uuid not null, channel_id uuid not null → channel on delete cascade, channel_ref varchar(100), action varchar(10), outcome varchar(10) not null check in ('created','modified','cancelled','duplicate','rejected'), reason text, booking_id uuid null → booking, payload jsonb not null, received_at timestamptz not null default now())`, index `(channel_id, received_at desc)`
  - `booking.channel_id uuid null → channel`, `booking.channel_ref varchar(100) null`, unique index `idx_booking_channel_ref ON booking (channel_id, channel_ref) WHERE channel_id IS NOT NULL`.
- Indexes on `channel(property_id)`, `channel_mapping(channel_id)`, `channel_trim(channel_id)`.

- [ ] **Step 1:** Create `scripts/check-channels.js` with the harness (fixtures: property `P` "Channel Check" currency `EUR`, property `Q` "Channel Check Other", one room type `RT` base 100 with rooms `101`,`102`, a second type `RT2` base 200 with room `201`; seed nights with `availabilitySeeder.seedRoomAvailability(roomId)`), and the first check:

```js
await check('schema: channel tables and booking columns exist', async () => {
  for (const t of ['channel', 'channel_mapping', 'channel_trim', 'channel_ari', 'channel_reservation_log'])
    assert.ok((await one(`SELECT to_regclass($1) AS r`, [t])).r, t);
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'booking' AND column_name IN ('channel_id','channel_ref')`)).rows;
  assert.equal(cols.length, 2);
});
```

- [ ] **Step 2:** `node -r dotenv/config scripts/check-channels.js` → FAIL on that check.
- [ ] **Step 3:** Write the migration (idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE … INDEX IF NOT EXISTS`) and mirror it in `schema.sql`. Apply **locally only** — `run-migration.js` also applies to `DATABASE_URL_LIVE` when set, so blank it: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-11-04-channels.sql` (expect `DATABASE_URL_LIVE: not set, skipped`).
- [ ] **Step 4:** Re-run → `ok   schema: …`.
- [ ] **Step 5:** Commit `Channels: schema (channel, mappings, trims, ARI snapshot, inbound log, booking source)`.

---

### Task 2: Adapters + desired grid

**Files:**
- Create: `src/lib/channels/index.js`, `src/lib/channels/test.js`, `src/lib/channels/desired.js`
- Test: `scripts/check-channels.js`

**Interfaces:**
- Produces:
  - `ADAPTERS` (`index.js`): `{ test: require('./test') }`. An adapter is `{ label: string, validateConfig(config) -> string[] (errors), push(channel, changes) -> Promise<Array<{ ok: boolean, error?: string }>> }` (results parallel to `changes`).
  - Test adapter: `validateConfig` accepts `{}` or `{ fail_pushes: boolean }`; `push` returns all `{ ok: true }`, or all `{ ok: false, error: 'test adapter: fail_pushes' }` when `channel.config.fail_pushes === true`.
  - `desiredAri(db, channel) -> Promise<Row[]>` where `Row = { mapping_id, room_code, rate_code, date: 'YYYY-MM-DD', available: number, rate: number, stop_sell: boolean }`, one row per mapping (`active` and `closing`) per date in `[CURRENT_DATE, CURRENT_DATE + horizon_days)`, ordered by mapping, date. `channel` is the full `channel` row.
  - Rules: available/rate per Global Constraints; trims for the date that match the mapping's room type or have `room_type_id IS NULL`: cap = smallest `max_available`, stop-sell = any `stop_sell`. Mapping `closing` **or** channel `pausing` ⇒ `available 0, stop_sell true` (rate still computed). Dates with no `room_availability` row count 0 rooms. `rate` is a number with 2 dp (use `applyAdjustment` from `src/lib/ratePlans.js`).

- [ ] **Step 1:** Add checks (insert a channel `{ adapter:'test', name:'Test', property P }` and mappings directly with SQL; `d0` = today, `d1` = today+1 from `SELECT CURRENT_DATE`):

```js
await check('desired: free count, type rate, plan adjustment', async () => {
  // RT: 2 rooms; room_type_rate on d1 = 120; plan Saver -10% on RT mapped as (DBL, SAVER); base mapping (DBL, BAR)
  const rows = await desiredAri(pool, ch);
  const at = (rate_code, date) => rows.find((r) => r.rate_code === rate_code && r.date === date);
  assert.deepEqual([at('BAR', d0).available, at('BAR', d0).rate, at('BAR', d0).stop_sell], [2, 100, false]);
  assert.equal(at('BAR', d1).rate, 120);
  assert.equal(at('SAVER', d1).rate, 108);
  assert.equal(rows.filter((r) => r.rate_code === 'BAR').length, ch.horizon_days);
});
await check('desired: booked night and override_rate', async () => {
  // set room 101 d0 is_available=false and override_rate 50 on room 102 d0
  assert.equal(at('BAR', d0).available, 1);
  assert.equal(at('BAR', d0).rate, 100); // overrides not advertised
});
await check('desired: inactive rooms not counted', async () => {
  // room 102 status 'inactive' (nights still open)
  assert.equal(at('BAR', d1).available, 1);
});
await check('desired: cap, overlapping caps, stop-sell, all-types trim', async () => {
  // trim RT d0..d0 max 1; trim NULL type d0..d0 max 3 → 1; trim RT d1..d1 stop_sell → 0 + stop_sell; RT2 untouched by RT trims
});
await check('desired: pausing channel and closing mapping close out', async () => {
  // channel.status 'pausing' → every row available 0, stop_sell true; reset; mapping SAVER closing → only SAVER rows closed
});
await check('test adapter: ok, fail_pushes, validateConfig', async () => {
  assert.deepEqual(await ADAPTERS.test.push({ config: {} }, [{}, {}]), [{ ok: true }, { ok: true }]);
  assert.equal((await ADAPTERS.test.push({ config: { fail_pushes: true } }, [{}]))[0].ok, false);
  assert.deepEqual(ADAPTERS.test.validateConfig({ fail_pushes: 'yes' }).length, 1);
});
```

- [ ] **Step 2:** Run → FAIL (modules missing).
- [ ] **Step 3:** Implement. One SQL query for counts per room type per date (`room r JOIN room_availability ra … WHERE r.property_id = $1 AND r.status = 'active' AND ra.date BETWEEN … GROUP BY r.room_type_id, ra.date`), one for type rates, one for trims; assemble in JS.
- [ ] **Step 4:** Run → all `ok`.
- [ ] **Step 5:** Commit `Channels: adapter registry, test adapter, desired ARI grid`.

---

### Task 3: Sync engine, drift, pausing/closing, job + nudge

**Files:**
- Create: `src/lib/channels/sync.js`
- Modify: `src/lib/roomPayments.js` (`refreshAvailabilityView` calls `require('./channels/sync').requestSync()` after the refresh, lazy-required to avoid a cycle), `src/controllers/bookings.js:337-341`, `src/controllers/availability.js:195-199,242`, `src/controllers/roomTypes.js:9-15` (replace direct `REFRESH` with `roomPayments.refreshAvailabilityView()`; keep `refreshView` route's own refresh but call `requestSync()` after it), `src/server.js` (`startChannelSyncJob()`)
- Test: `scripts/check-channels.js`

**Interfaces:**
- Consumes: `desiredAri`, `ADAPTERS`.
- Produces (`sync.js`):
  - `drift(db, channel, { from?, to? } = {}) -> Promise<{ changes: Array<Row & { previous: { available, rate, stop_sell, status, error } | null }>, failed: number, oldest_failing_date: string | null }>` — `changes` = desired rows with no snapshot row, different values (compare rate in cents), or snapshot `status = 'failed'`; optional date filter. `paused` channel ⇒ `{ changes: [], failed: 0, oldest_failing_date: null }`.
  - `syncChannel(channelId) -> Promise<{ pushed: number, ok: number, failed: number } | { skipped: 'locked' | 'paused' }>` — takes `pg_try_advisory_lock(hashtext('channel_sync:' || id))` on a dedicated client (released in `finally`); on failure to lock returns `{ skipped: 'locked' }`. Pushes `drift().changes` in batches of 500 through the adapter; upserts `channel_ari` per result (`status 'ok'` with the new values, or `'failed'` with `error`, keeping the old values when there were some). An adapter throw marks the whole batch failed with `err.message`. Afterwards: deletes `channel_ari` rows with `date < CURRENT_DATE`; if channel is `pausing` and `drift` is now empty ⇒ status `paused`; each `closing` mapping with no drift ⇒ deleted (its snapshot cascades).
  - `syncAll() -> Promise<void>` — `syncChannel` for every channel with status `active` or `pausing`, sequentially, errors logged per channel.
  - `requestSync() -> void` — debounced 2000 ms `syncAll()`; no-op in check scripts unless called explicitly (export `_flush()` returning the pending promise for tests).
  - `startChannelSyncJob() -> void` — `setInterval(syncAll, 60_000)` with `.unref()`, like the other `start…Job`s.

- [ ] **Step 1:** Add checks (start from a fresh channel + mappings and reset the Task 2 fixture edits — room statuses, nights, trims — so counts below hold):

```js
await check('sync: first sync sends the whole grid, drift then empty', async () => {
  const r = await syncChannel(ch.id);
  assert.equal(r.failed, 0); assert.equal(r.pushed, rowsFor(ch).length);
  assert.equal((await drift(pool, ch)).changes.length, 0);
});
await check('sync: direct booking shows as drift for exactly its nights', async () => {
  // POST /api/bookings room_type_id RT d0..d2 (2 nights)
  const d = await drift(pool, await chRow());
  assert.deepEqual(d.changes.map((c) => c.date).sort(), [d0, d1, d0, d1].sort()); // BAR + SAVER
  assert.equal(d.changes[0].previous.available, 2);
});
await check('sync: rate edit shows as drift', async () => { /* PUT /api/room-types/RT/rates d5 = 130 → BAR d5 and SAVER d5 in drift */ });
await check('sync: fail_pushes → failed counted, keeps old values; clearing it heals', async () => {
  // set config.fail_pushes, change a rate, sync → failed > 0, drift.failed > 0, oldest_failing_date set
  // unset, sync → failed 0, drift empty
});
await check('sync: concurrent syncs push once', async () => {
  // change RT's rate on one date (→ 2 rows: BAR + SAVER); const [a, b] = await Promise.all([syncChannel(id), syncChannel(id)]);
  assert.equal((a.pushed || 0) + (b.pushed || 0), 2); // the other run was skipped ('locked') or found nothing
});
await check('sync: pausing pushes close-out then becomes paused', async () => {
  // status 'pausing' → syncChannel → every snapshot row available 0 stop_sell true; status now 'paused'; syncChannel → { skipped: 'paused' }
});
await check('sync: closing mapping is closed out then removed', async () => { /* mapping SAVER closing → sync → mapping row gone, its channel_ari gone */ });
await check('sync: nudge after a booking', async () => {
  // book via API, then await sync._flush(); drift empty
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `sync.js`; wire the helper + nudge + job.
- [ ] **Step 4:** Run `check-channels.js` → all `ok`; regression: `node -r dotenv/config scripts/check-rate-plans.js` and `scripts/check-room-baskets.js` → all `ok`.
- [ ] **Step 5:** Commit `Channels: sync engine (desired vs snapshot diff), drift, close-out on pause/unmap, 60s job + nudge`.

---

### Task 4: Shared room placement

**Files:**
- Create: `src/lib/roomPlacement.js`
- Modify: `src/controllers/bookings.js:138-145,245-329` (use it; behaviour unchanged)
- Test: existing `scripts/check-rate-plans.js`, `scripts/check-room-baskets.js`, `scripts/check-multi-property-http.js` (regression) + one new check in `check-channels.js`

**Interfaces:**
- Produces:
  - `stayNights(checkIn, checkOut) -> string[]` (dates in `[check_in, check_out)`).
  - `placeBooking(client, { candidates, nights, insert }) -> Promise<{ booked: object | null, lastUnavailableDate: string | null }>` — `candidates: Array<{ id, base_rate }>`, `nights: string[]`, `insert(candidate, availMap) -> Promise<bookingRow>` (`availMap[date] = { is_available, override_rate }`). Per candidate: `SAVEPOINT`, read nights, skip unless every night has an available row, call `insert`, `RELEASE`; on `23P01` roll back to the savepoint and try the next. On success sets `is_available = false` for the booked room's nights. Caller owns `BEGIN/COMMIT`.

- [ ] **Step 1:** Add check `placeBooking: skips a taken room, fails cleanly when none free` (two candidates, first booked on d0; result is the second; then both booked → `booked null`, `lastUnavailableDate d0`).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Extract; `createBooking` keeps its pricing, plan, status and response logic inside its `insert` callback.
- [ ] **Step 4:** Run `check-channels.js`, `check-rate-plans.js`, `check-room-baskets.js`, `check-multi-property-http.js` → all `ok`.
- [ ] **Step 5:** Commit `Rooms: extract room placement from createBooking (shared with channel reservations)`.

---

### Task 5: Inbound reservations + staff cancel guard

**Files:**
- Create: `src/lib/channels/reservations.js`
- Modify: `src/lib/ably.js` (`publishChannelReservationRejected(propertyId, payload)` — event `channel-reservation-rejected` on the same Ably channel `publishNewBooking` uses), `src/controllers/bookings.js` (`cancelBooking` guard)
- Test: `scripts/check-channels.js`

**Interfaces:**
- Consumes: `placeBooking`, `stayNights`, `roomPayments.releaseAvailability`, `roomPayments.refreshAvailabilityView`, `roomPayments.fetchJoinedBooking`, `publishNewBooking`, `publishBookingStatusChanged`.
- Produces: `receiveReservation(channel, reservation) -> Promise<{ outcome: 'created'|'modified'|'cancelled'|'duplicate'|'rejected', booking_id?: string, reason?: string }>`.
  - `reservation = { channel_ref: string, action: 'new'|'modify'|'cancel', room_code?, rate_code?, check_in?, check_out?, guests?: int, total_price?: number, currency?: string, collect?: 'hotel'|'channel', guest?: { first_name, last_name, email?, phone? } }` (`new`/`modify` need room/rate codes, dates, total_price, guest names).
  - Never throws for bad input: validation problems ⇒ `rejected` with a reason. Every call writes one `channel_reservation_log` row (`payload` = the reservation) in the same transaction as its effect (a rejected one is logged after rollback).
  - Rejection reasons (exact strings): `'invalid reservation: <field>'`, `'unknown room/rate code'` (also for a `closing` mapping), `'currency mismatch'` (when `currency` given and ≠ `property.currency`), `'no room available'`, `'unknown reservation'`, `'booking already in house'` (status `checked_in`/`checked_out`).
  - `new`: duplicate `(channel_id, channel_ref)` ⇒ `duplicate` + existing `booking_id`. Guest: `INSERT … ON CONFLICT (property_id, email) DO UPDATE SET first_name = guest.first_name RETURNING id`; missing email ⇒ `` `${channel_ref}@channel-${channel.id}.invalid` `` lowercased. Booking: `room_type_id` from mapping, `rate_plan_id` from mapping, `rate_plan_terms` null, status `confirmed`, `total_price`, `channel_id`, `channel_ref`, `metadata {}`. If effective collect (`reservation.collect ?? channel.collect`) is `channel`: `payment (property_id, booking_id, amount = total_price, method 'channel', status 'completed', paid_at now())`. After commit: refresh helper (nudges sync), `publishNewBooking`.
  - `no room available` ⇒ also `publishChannelReservationRejected(property_id, { channel_id, channel_ref, reason })`.
  - `modify`: lock the booking by `(channel_id, channel_ref)`; release its nights; `placeBooking` the new stay (any room of the new type; the current room is a candidate again because its nights were released); on success update dates/room/guests/total/rate_plan and the `channel` payment amount (insert/remove it if `collect` changed); on failure roll back everything ⇒ `rejected 'no room available'`, original untouched.
  - `cancel`: status `cancelled`, `payment_due_at NULL`, `releaseAvailability`, `payment` rows `method 'channel'` ⇒ `status 'refunded'`; repeat cancel ⇒ `duplicate`. After commit: refresh helper, `publishBookingStatusChanged`.
- `cancelBooking` (staff `DELETE /api/bookings/:id`): when `booking.channel_id` and not (`req.body?.force === true || req.query.force === 'true'`) ⇒ `409 { error: 'This booking came from a channel; cancel it on the channel', details: 'Pass force: true to cancel it in OTA only' }`.

- [ ] **Step 1:** Add checks (call `receiveReservation` directly; `res = (o) => ({ channel_ref: 'R1', action: 'new', room_code: 'DBL', rate_code: 'BAR', check_in: d3, check_out: d5, guests: 2, total_price: 180, currency: 'EUR', guest: { first_name: 'Ana', last_name: 'Silva', email: 'ana@example.com' }, ...o })`):

```js
await check('inbound: new → confirmed booking with source, hotel collect owes full stay', async () => {
  const r = await receiveReservation(ch, res());
  assert.equal(r.outcome, 'created');
  const b = await one('SELECT * FROM booking WHERE id = $1', [r.booking_id]);
  assert.deepEqual([b.status, b.channel_ref, Number(b.total_price)], ['confirmed', 'R1', 180]);
  assert.equal((await computeFolio(b.id, P)).balance, 180);
});
await check('inbound: resend is duplicate, same booking', async () => { /* outcome duplicate, same booking_id, one booking row */ });
await check('inbound: channel collect → folio balance 0', async () => { /* R2 collect 'channel' → balance 0, payment method 'channel' completed */ });
await check('inbound: last room twice → one booking, one rejected + log', async () => {
  // RT2 has one room: R3 and R4 same nights → created, rejected 'no room available'; log has both rows
});
await check('inbound: unknown code / currency mismatch / missing fields rejected', async () => {
  assert.equal((await receiveReservation(ch, res({ channel_ref: 'X1', room_code: 'NOPE' }))).reason, 'unknown room/rate code');
  assert.equal((await receiveReservation(ch, res({ channel_ref: 'X2', currency: 'USD' }))).reason, 'currency mismatch');
  assert.match((await receiveReservation(ch, res({ channel_ref: 'X3', check_in: 'bad' }))).reason, /^invalid reservation/);
});
await check('inbound: missing email gets a stable placeholder', async () => { /* guest.email = 'r5@channel-<id>.invalid'; resend R5 modify reuses it */ });
await check('inbound: modify moves dates; impossible modify keeps original', async () => { /* R1 → d6..d8 ok, nights released/taken; then modify to RT2 nights held by R3 → rejected, R1 unchanged */ });
await check('inbound: cancel frees nights, refunds channel payment; repeat is duplicate', async () => { /* R2 cancel → cancelled, payment refunded, nights free */ });
await check('inbound: modify/cancel unknown ref or in-house booking rejected', async () => {
  assert.equal((await receiveReservation(ch, { channel_ref: 'ZZ', action: 'cancel' })).reason, 'unknown reservation');
  // set R1 checked_in → cancel → 'booking already in house'
});
await check('inbound: paused channel still accepts', async () => { /* status paused → new R6 created */ });
await check('staff DELETE of a channel booking needs force', async () => {
  assert.equal((await api('DELETE', `/api/bookings/${id}`)).status, 409);
  assert.equal((await api('DELETE', `/api/bookings/${id}?force=true`)).status, 200);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `check-channels.js` + `check-rate-plans.js` → all `ok`.
- [ ] **Step 5:** Commit `Channels: inbound reservations (new/modify/cancel, idempotent, hotel/channel collect) + staff cancel guard`.

---

### Task 6: HTTP API, Swagger, MCP tools

**Files:**
- Create: `src/controllers/channels.js`, `src/routes/channels.js`
- Modify: `src/app.js` (`app.use('/api/channels', require('./routes/channels'))`), `src/controllers/bookings.js` (`listBookings` filter `channel_id` — `'direct'` ⇒ `b.channel_id IS NULL`, uuid ⇒ equality, on both query and count), `src/docs/swagger.js` (tag `Channels`, every route below + `channel_id` on bookings list + `force` on booking DELETE), `mcp-server/tools.js`
- Test: `scripts/check-channels.js`, `scripts/check-mcp-coverage.js`

**Interfaces:**
- Consumes: `ADAPTERS`, `drift`, `syncChannel`, `receiveReservation`, `refreshAvailabilityView`.
- Routes (all `staffOrFullKey`; channel looked up by `id AND property_id`, else 404; `config` returned with every key except `fail_pushes` replaced by `'***'`):

| Route | Body / query | Response |
|---|---|---|
| `GET /api/channels` | | channels |
| `POST /api/channels` | `{ adapter, name, horizon_days?, collect?, config? }` | 201 channel; 400 unknown adapter / `validateConfig` errors in `details` / bad horizon/collect |
| `GET /api/channels/:id` | | channel + `{ mappings, trims }` |
| `PUT /api/channels/:id` | `{ name?, horizon_days?, collect?, config?, status?: 'active'\|'paused' }` | channel; `status 'paused'` sets `pausing` (and `requestSync()`); `'active'` from `paused`/`pausing` sets `active` |
| `DELETE /api/channels/:id` | | 204; 409 unless `paused`; 409 if any booking references it |
| `PUT /api/channels/:id/mappings` | `{ mappings: [{ room_type_id, rate_plan_id?, room_code, rate_code }] }` | the mapping list; existing (room_code, rate_code) kept/updated, new inserted, missing ones set `closing`; 400 if a room type / plan isn't this property's or the plan isn't that type's; 400 duplicate codes |
| `GET /api/channels/:id/trims` | | trims |
| `POST /api/channels/:id/trims` | `{ room_type_id?, date_from, date_to, max_available?, stop_sell? }` | 201; 400 per table checks |
| `DELETE /api/channels/:id/trims/:trim_id` | | 204 |
| `POST /api/channels/:id/sync` | | `syncChannel` result |
| `GET /api/channels/:id/drift` | `from?, to?` | `drift` result, `changes` capped at 500 plus `total` |
| `GET /api/channels/:id/inbound` | `limit?` (default 50, max 200) | log rows newest first |
| `POST /api/channels/:id/test-reservations` | the reservation shape | `receiveReservation` result; 201 for `created`, 200 otherwise, 409 for `rejected`; 404 when adapter ≠ `test` |

- MCP tools (each `apiRequest` like neighbours): `list_channels`, `create_channel`, `get_channel`, `update_channel`, `delete_channel`, `set_channel_mappings`, `list_channel_trims`, `create_channel_trim`, `delete_channel_trim`, `sync_channel`, `get_channel_drift`, `list_channel_inbound`, `send_test_channel_reservation`; add `channel_id` to `list_bookings` and `force` to `cancel_booking`.

- [ ] **Step 1:** Add HTTP checks: create (400 unknown adapter; 201 ok; config masked), cross-property GET ⇒ 404 with `Q`'s key, mappings replace (400 foreign room type; removed one ⇒ `closing`), trims CRUD, `sync` then `drift` ⇒ `changes: []`, pause via PUT ⇒ `pausing` then after sync `paused`, DELETE while active ⇒ 409, `test-reservations` ⇒ 201 then 200 `duplicate`, on a non-test adapter ⇒ 404 (insert a row with `adapter 'other'` via SQL), `GET /api/bookings?channel_id=direct` excludes channel bookings.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement controller, routes, mount, swagger, MCP tools.
- [ ] **Step 4:** Run `check-channels.js` → all `ok`; `node -r dotenv/config scripts/check-mcp-coverage.js` → passes; `check-core-mcp.js` → passes.
- [ ] **Step 5:** Commit `Channels: HTTP API, Swagger, MCP tools`.

---

### Task 7: End-to-end on Bloody Mary, then ship

- [ ] **Step 1:** Run every check touched: `check-channels`, `check-rate-plans`, `check-room-baskets`, `check-multi-property-http`, `check-mcp-coverage`, `check-core-mcp` → all pass.
- [ ] **Step 2:** Locally, against the Bloody Mary property (look up its id; if the local DB lacks it, say so and use a local copy property): run the spec's six success checks through the HTTP API with its API key (create test channel, map, sync, book directly, edit a rate, cap + stop-sell, test reservations incl. overbook and both collect modes, `fail_pushes` on/off). Note results.
- [ ] **Step 3:** Ask Robert for OK to run `migrate-2026-11-04-channels.sql` on live (`node scripts/run-migration.js src/db/migrate-2026-11-04-channels.sql`; local half is a no-op re-run). Only after it succeeds: `git push`.
- [ ] **Step 4:** Update memory (`project_channels_state.md` + `MEMORY.md` line): live date, commit, outstanding (Channex sandbox adapter, OpenTravel XML adapter, dashboard UI, commission).
