# Equipment hire: hourly time windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Equipment availability counts peak concurrent use over a hire's time window (per-hour hires with a start time) instead of summing every hire on the day, with opening hours, computed start times, and a row lock against double-selling.

**Architecture:** One pure module (`src/lib/equipmentWindows.js`) owns window maths (`hireWindow`, `peakUse`, `startTimes`, `fitsHours`). The controller loads the day's hires, calls it, and serialises hires per item with `SELECT … FOR UPDATE` on the `equipment` row. No slot table; three nullable/defaulted columns on `equipment`.

**Tech Stack:** Node/Express, `pg`, plain `node:assert` check script (no test framework).

**Spec:** `docs/superpowers/specs/2026-10-16-equipment-hire-time-windows-design.md`

## Global Constraints

- Whole-day window is `{ start: 0, end: 1440 }` (minutes from midnight). Only `rate_type = 'per_hour'` **with** `start_time` is timed; everything else is whole-day, exactly as today.
- Windows are half-open `[start, end)`: 10–11 and 11–12 do not overlap.
- `per_hour` duration: positive multiple of 0.5. Timed window must end by 24:00 (1440).
- `slot_interval_minutes`: integer 5–240, default 60. `open_time`/`close_time`: both or neither, `close_time > open_time`.
- `quantity` positive integer; prices non-negative.
- Error copy, verbatim: `Hire must be between 09:00 and 19:00` (times from the item), `Only N available from 10:00 to 12:00`, `Only N available on this date`, `That time has passed`.
- "Today"/"now" are in `property.timezone` (default `Europe/London`), read from Postgres: `(now() AT TIME ZONE p.timezone)`.
- No interpolated values in SQL (the old `HAVING … ${parseInt(quantity)}` goes).
- `pg` returns `TIME` as `'HH:MM:SS'`; all helpers accept `HH:MM` or `HH:MM:SS`. API output for computed starts is `HH:MM`.
- Checks run against the local DB only. `run-migration.js` also hits `DATABASE_URL_LIVE` — blank it for local runs. Live migration and `git push` need the user's go-ahead (Task 5). Commit directly on `main`.

## Review Focus

1. **Window crossing midnight** (`23:00` + 2h) → 400, never wraps to 01:00 or stores silently. Test in Task 3.
2. **Legacy rows**: `per_hour` hire with `start_time` but `duration` NULL counts as 1 hour; `per_hour` hire with no `start_time` blocks the whole day. Test in Task 1.
3. **Oversize numbers** (`quantity: 3e9`, `price_per_day: 1e9`, per-day `duration: 1000`) → 400, never a Postgres overflow 500. Tests in Tasks 2 and 3.
4. **Non-UUID ids** (`equipment_id: 'abc'` in body, `PUT /hires/abc`, `PUT /equipment/abc`) → 400/404, never 500. Tests in Tasks 2 and 3.
5. **Hire whose equipment row is `inactive`** being reinstated → 409 `Equipment not available`, same as create. Test in Task 3.

---

### Task 1: Migration + pure window module

**Files:**
- Create: `src/db/migrate-2026-10-16-equipment-hours.sql`
- Modify: `src/db/schema.sql:912-922` (add the three columns to `equipment`)
- Create: `src/lib/equipmentWindows.js`
- Create: `scripts/check-equipment.js`

**Interfaces:**
- Produces (all in `src/lib/equipmentWindows.js`):
  - `toMinutes(time: 'HH:MM'|'HH:MM:SS') → number`
  - `fmt(minutes: number) → 'HH:MM'`
  - `hireWindow(hire: { rate_type, start_time, duration }) → { start, end }` — timed: `start = toMinutes(start_time)`, `end = start + round(Number(duration ?? 1) * 60)`; else `{ 0, 1440 }`.
  - `peakUse(hires: Array<{ rate_type, start_time, duration, quantity }>, window: { start, end }) → number`
  - `fitsHours(item: { open_time, close_time }, window) → boolean` — `window.end <= 1440` and, if hours set, `start >= open && end <= close`.
  - `startTimes(item: { quantity, open_time, close_time, slot_interval_minutes }, hires, durationHours: number, quantity = 1, now: number|null = null) → Array<{ start_time: 'HH:MM', available_quantity: number }>`

- [ ] **Step 1: Write the migration and mirror it into schema.sql**

Header comment in the same style as `migrate-2026-10-15-courses.sql` (purpose + run command), then the three `ALTER TABLE equipment ADD COLUMN IF NOT EXISTS` lines from the spec's Data model. Add `open_time TIME, close_time TIME, slot_interval_minutes INT NOT NULL DEFAULT 60` to the `CREATE TABLE equipment` in `schema.sql`.

- [ ] **Step 2: Apply locally, twice (idempotent)**

Run (PowerShell): `$env:DATABASE_URL_LIVE=''; node scripts/run-migration.js src/db/migrate-2026-10-16-equipment-hours.sql; node scripts/run-migration.js src/db/migrate-2026-10-16-equipment-hours.sql`
Expected: both runs succeed; `DATABASE_URL_LIVE: not set, skipped`.

- [ ] **Step 3: Write the check script skeleton with the pure checks**

Copy `scripts/check-courses.js`'s scaffolding (env deletes, remote-DB refusal, `check()`, ephemeral server, throwaway property with `api_key`, `api()` helper, `finally` cleanup deleting `equipment_hire`, `equipment`, `property` for the throwaway ids). Pure checks, where `h(start, dur, qty = 1)` builds `{ rate_type: 'per_hour', start_time: start, duration: dur, quantity: qty }`:

```js
await check('hireWindow: timed, whole-day, legacy', async () => {
  assert.deepEqual(hireWindow(h('10:00', 1.5)), { start: 600, end: 690 });
  assert.deepEqual(hireWindow({ rate_type: 'per_hour', start_time: '10:00:00', duration: null }), { start: 600, end: 660 });
  assert.deepEqual(hireWindow({ rate_type: 'per_hour', start_time: null, duration: 2 }), { start: 0, end: 1440 });
  assert.deepEqual(hireWindow({ rate_type: 'per_day', start_time: '10:00', duration: 1 }), { start: 0, end: 1440 });
});
await check('peakUse: back-to-back do not stack; overlap does', async () => {
  assert.equal(peakUse([h('10:00', 1), h('11:00', 1)], { start: 600, end: 720 }), 1);
  assert.equal(peakUse([h('10:00', 1), h('10:30', 1)], { start: 600, end: 720 }), 2);
  assert.equal(peakUse([h('10:00', 1, 3)], { start: 660, end: 720 }), 0);
  assert.equal(peakUse([{ rate_type: 'per_day', quantity: 2 }, h('10:00', 1)], { start: 600, end: 660 }), 3);
});
await check('fitsHours', async () => {
  const item = { open_time: '09:00:00', close_time: '19:00:00' };
  assert.equal(fitsHours(item, { start: 540, end: 600 }), true);
  assert.equal(fitsHours(item, { start: 480, end: 540 }), false);
  assert.equal(fitsHours(item, { start: 1080, end: 1200 }), false);
  assert.equal(fitsHours({ open_time: null, close_time: null }, { start: 1380, end: 1500 }), false);
});
await check('startTimes: 2h on a 09-13 quantity-1 item with 10-11 taken', async () => {
  const item = { quantity: 1, open_time: '09:00', close_time: '13:00', slot_interval_minutes: 60 };
  assert.deepEqual(startTimes(item, [h('10:00', 1)], 2), [{ start_time: '11:00', available_quantity: 1 }]);
});
await check('startTimes: now = 12:00 drops 10:00 and 11:00', async () => {
  const item = { quantity: 1, open_time: '10:00', close_time: '14:00', slot_interval_minutes: 60 };
  assert.deepEqual(startTimes(item, [], 1, 1, 720).map((s) => s.start_time), ['12:00', '13:00']);
});
```

- [ ] **Step 4: Run — expect FAIL** (`Cannot find module '../src/lib/equipmentWindows'`)

Run: `node -r dotenv/config scripts/check-equipment.js`

- [ ] **Step 5: Implement `src/lib/equipmentWindows.js`**

`peakUse`: only hires whose window overlaps `window` count. Candidate instants are `window.start` plus each overlapping hire's start strictly inside the window; at instant `t` a hire is out if `start <= t < end`. Return the max sum of `quantity` (0 if none). `startTimes` walks from `open_time` (or 0) in `slot_interval_minutes` steps, keeps starts where `fitsHours` holds and `now == null || start >= now`, computes `available_quantity = item.quantity − peakUse(hires, window)`, keeps `>= quantity`.

- [ ] **Step 6: Run — expect all pure checks `ok`**

- [ ] **Step 7: Commit**

```bash
git add src/db/migrate-2026-10-16-equipment-hours.sql src/db/schema.sql src/lib/equipmentWindows.js scripts/check-equipment.js
git commit -m "Equipment: opening-hours columns and pure hire-window helpers"
```

---

### Task 2: Equipment create/update validation and hours

**Files:**
- Modify: `src/controllers/equipment.js:20-53`
- Test: `scripts/check-equipment.js`

**Interfaces:**
- Produces: `equipmentError(row) → string|null` (module-private in the controller) validating a full equipment row: `name`/`type` present; `quantity` integer 1…2147483647; `price_per_day`/`price_per_hour` null or number 0…99999999.99; `open_time`/`close_time` both null or both valid times (`isValidTime` on the first 5 chars) with close > open; `slot_interval_minutes` integer 5…240.

- [ ] **Step 1: Add the failing checks**

```js
let kayak;
await check('create equipment: validation', async () => {
  const base = { name: 'Kayak', type: 'kayak', quantity: 1, price_per_hour: 15 };
  for (const bad of [{ quantity: 0 }, { quantity: 3e9 }, { price_per_day: -1 }, { price_per_day: 1e9 },
                     { open_time: '09:00' }, { open_time: '19:00', close_time: '09:00' },
                     { open_time: '25:00', close_time: '26:00' }, { slot_interval_minutes: 2 }]) {
    assert.equal((await api('POST', '/api/equipment', { ...base, ...bad })).status, 400, JSON.stringify(bad));
  }
  const r = await api('POST', '/api/equipment', { ...base, open_time: '09:00', close_time: '19:00', slot_interval_minutes: 30 });
  assert.equal(r.status, 201); kayak = r.body;
  assert.equal(kayak.open_time, '09:00:00'); assert.equal(kayak.slot_interval_minutes, 30);
});
await check('update equipment: clear hours with null; half-set rejected; absent keeps', async () => {
  assert.equal((await api('PUT', `/api/equipment/${kayak.id}`, { close_time: '08:00' })).status, 400);
  assert.equal((await api('PUT', `/api/equipment/${kayak.id}`, { name: 'Kayak 2' })).body.open_time, '09:00:00');
  const r = await api('PUT', `/api/equipment/${kayak.id}`, { open_time: null, close_time: null });
  assert.equal(r.status, 200); assert.equal(r.body.open_time, null); assert.equal(r.body.close_time, null);
  assert.equal((await api('PUT', `/api/equipment/${kayak.id}`, { open_time: '09:00', close_time: '19:00' })).status, 200);
});
await check('update equipment: non-UUID id is 404', async () => {
  assert.equal((await api('PUT', '/api/equipment/abc', { name: 'x' })).status, 404);
});
```

- [ ] **Step 2: Run — expect these FAIL**

- [ ] **Step 3: Implement**

`createEquipment`: build the row from the body (`slot_interval_minutes` defaults to 60), `equipmentError` → 400 `{ error }`, insert the three new columns too. `updateEquipment` (decision 10): non-UUID id → 404; transaction; `SELECT … WHERE id AND property_id FOR UPDATE` → 404; merge — for `open_time`/`close_time`, `key in body` wins (so `null` clears); for every other field, `body[key] ?? row[key]` (today's COALESCE behaviour); validate merged row → 400; `UPDATE` all columns from the merged row; commit.

- [ ] **Step 4: Run — expect `ok`**

- [ ] **Step 5: Commit** — `git commit -am "Equipment: validate items and accept opening hours"`

---

### Task 3: Window-aware hires under a lock

**Files:**
- Modify: `src/controllers/equipment.js:105-165`
- Test: `scripts/check-equipment.js`

**Interfaces:**
- Consumes: `hireWindow`, `peakUse`, `fitsHours`, `fmt` (Task 1).
- Produces (module-private, reused by Task 4):
  - `propertyNow(db, propertyId) → { today: 'YYYY-MM-DD', nowMinutes: number }` — one query: `to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD')` and hour*60+minute of the same.
  - `dayHires(db, propertyId, date, equipmentIds: string[], excludeHireId = null) → Map<equipment_id, hire[]>` — non-cancelled hires on `date`.
  - `shortfall(item, hires, window, quantity) → string|null` — `'Only N available from HH:MM to HH:MM'` (timed) or `'Only N available on this date'` (whole-day) when `quantity > item.quantity − peakUse`.

- [ ] **Step 1: Add the failing checks**

Fixtures: `one` = quantity-1 item, no hours, `price_per_hour: 10, price_per_day: 50`; `two` = quantity-2 item, hours 09:00–19:00. Date `D = '2030-07-01'`. `hire(eq, start, dur, extra)` posts `{ equipment_id: eq.id, contact_name: 'Ana', hire_date: D, quantity: 1, rate_type: 'per_hour', start_time: start, duration: dur, ...extra }`.

```js
await check('quantity 1: back-to-back ok, overlap 409', async () => {
  assert.equal((await hire(one, '10:00', 1)).status, 201);
  assert.equal((await hire(one, '11:00', 1)).status, 201);
  const r = await hire(one, '10:30', 1);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'Only 0 available from 10:30 to 11:30');
});
await check('quantity 2: 10-11 + 11-12 then 10-12 fits (peak 2); another 10-12 is 409', async () => {
  for (const [s, d] of [['10:00', 1], ['11:00', 1], ['10:00', 2]]) assert.equal((await hire(two, s, d)).status, 201);
  assert.equal((await hire(two, '10:00', 2)).status, 409);
});
await check('per-day blocks timed and vice versa', async () => { /* fresh quantity-1 item each way, other date */ });
await check('hours and midnight', async () => {
  const r = await hire(two, '08:00', 1, { hire_date: '2030-07-02' });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Hire must be between 09:00 and 19:00');
  assert.equal((await hire(two, '18:30', 1, { hire_date: '2030-07-02' })).status, 400);
  assert.equal((await hire(one, '23:00', 2, { hire_date: '2030-07-02' })).status, 400);
});
await check('validation and bad ids are 400', async () => {
  for (const bad of [{ quantity: 0 }, { quantity: 1.5 }, { duration: -1 }, { duration: 0.7 }, { start_time: '25:00' },
                     { rate_type: 'per_week' }, { equipment_id: 'abc' }, { rate_type: 'per_day', start_time: null, duration: 1000 }]) {
    assert.equal((await hire(one, '10:00', 1, { hire_date: '2030-07-03', ...bad })).status, 400, JSON.stringify(bad));
  }
});
await check('cancel frees the window; reinstating into a full window is 409', async () => {
  const a = (await hire(one, '14:00', 1, { hire_date: '2030-07-04' })).body;
  assert.equal((await api('PUT', `/api/equipment/hires/${a.id}`, { status: 'cancelled' })).status, 200);
  assert.equal((await hire(one, '14:00', 1, { hire_date: '2030-07-04' })).status, 201);
  assert.equal((await api('PUT', `/api/equipment/hires/${a.id}`, { status: 'confirmed' })).status, 409);
  assert.equal((await api('PUT', '/api/equipment/hires/abc', { status: 'confirmed' })).status, 404);
});
await check('reinstating a hire on an inactive item is 409', async () => { /* hire, cancel, set item inactive, reinstate → 409 'Equipment not available' */ });
await check('two concurrent hires for the last unit: one 201, one 409', async () => {
  const rs = await Promise.all([hire(one, '16:00', 1, { hire_date: '2030-07-05' }), hire(one, '16:00', 1, { hire_date: '2030-07-05' })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
});
await check('a timed hire today that has started is 400', async () => {
  const { today, mins } = await one(`SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today,
    extract(hour FROM now() AT TIME ZONE timezone)*60 + extract(minute FROM now() AT TIME ZONE timezone) AS mins FROM property WHERE id = $1`, [P]);
  if (Number(mins) === 0) return; // ponytail: skips in the first minute after local midnight
  const r = await hire(one, '00:00', 0.5, { hire_date: today });
  assert.equal(r.status, 400); assert.equal(r.body.error, 'That time has passed');
});
```

(The `one(...)` SQL helper from check-courses clashes with the `one` fixture name — call the fixture `single`.)

- [ ] **Step 2: Run — expect these FAIL**

- [ ] **Step 3: Implement `createHire`** per spec steps 1–5

Validation adds: `equipment_id` (and `guest_id`/`golf_booking_id` if given) valid UUID; `Number(quantity)` integer 1…2147483647; `rate_type` in `per_day`/`per_hour`; `Number(duration)` > 0 and < 1000; per-hour → `duration * 2` integer; `start_time` `isValidTime` if given. Lock: `SELECT * FROM equipment WHERE id = $1 AND property_id = $2 FOR UPDATE`. Timed → `fitsHours` else 400 (hours message when the item has hours, otherwise `'Hire must end by 24:00'`); `hire_date === today && start < nowMinutes` → 400 `That time has passed`. `shortfall` → 409. Price/insert unchanged.

- [ ] **Step 4: Implement `updateHire`**

Non-UUID id → 404. Transaction: `SELECT … FROM equipment_hire WHERE id AND property_id FOR UPDATE` → 404. If old status is `cancelled` and `status` is given and not `cancelled`: lock the equipment row (`FOR UPDATE`); inactive → 409 `Equipment not available`; `dayHires(…, excludeHireId = hire.id)` + `shortfall(item, hires, hireWindow(hire), hire.quantity)` → 409. Then the existing COALESCE update; commit. No past-start check on reinstate (staff action).

- [ ] **Step 5: Run — expect `ok`** (whole script)

- [ ] **Step 6: Commit** — `git commit -am "Equipment: hires check peak use over their time window under a row lock"`

---

### Task 4: Search with start times

**Files:**
- Modify: `src/controllers/equipment.js:57-78`
- Test: `scripts/check-equipment.js`

**Interfaces:**
- Consumes: `startTimes`, `hireWindow`-style windows, `fitsHours` (Task 1); `propertyNow`, `dayHires` (Task 3).
- Produces: `GET /api/equipment/search?date&type&quantity&start_time&duration` → array of equipment rows + `available_quantity`, and `start_times: [{ start_time, available_quantity }]` on items with `price_per_hour` when `start_time` is absent.

- [ ] **Step 1: Add the failing checks** (own date `2030-08-01`; items: `hourly` qty 2, hours 09:00–13:00, `price_per_hour`; `daily` qty 1, `price_per_day` only; one 10:00–11:00 hire on `hourly`)

```js
await check('search with start_time: window availability, leaves out per-day-only and out-of-hours', async () => {
  let r = await api('GET', '/api/equipment/search?date=2030-08-01&start_time=10:00&duration=1');
  const ids = r.body.map((e) => e.id);
  assert.ok(!ids.includes(daily.id));
  assert.equal(r.body.find((e) => e.id === hourly.id).available_quantity, 1);
  r = await api('GET', '/api/equipment/search?date=2030-08-01&start_time=12:00&duration=2');
  assert.ok(!r.body.some((e) => e.id === hourly.id));
});
await check('search without start_time: start_times for duration, ending by close', async () => {
  const r = await api('GET', '/api/equipment/search?date=2030-08-01&duration=2&quantity=2');
  const e = r.body.find((x) => x.id === hourly.id);
  assert.deepEqual(e.start_times.map((s) => s.start_time), ['11:00']);
  assert.ok(!r.body.some((x) => x.id === daily.id)); // qty 1 < 2
  const all = await api('GET', '/api/equipment/search?date=2030-08-01');
  assert.equal(all.body.find((x) => x.id === daily.id).start_times, undefined);
});
await check('search validation', async () => {
  for (const q of ['start_time=25:00', 'duration=0', 'duration=0.7', 'quantity=abc']) {
    assert.equal((await api('GET', `/api/equipment/search?date=2030-08-01&${q}`)).status, 400, q);
  }
});
```

Note: in the second check `quantity=2` filters on whole-day peak (2 − 1 = 1 < 2), so `hourly` would be dropped. Make that check use `quantity` only as the `startTimes` minimum: **apply the `quantity` filter to `available_quantity` only when `start_time` is given or the item has no `start_times`; otherwise filter `start_times` by it and drop the item if none are left.** (This is the plan's reading of "the `quantity` filter applies to that number" — the per-day peak would hide hourly kit that has free slots.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement**

Validate `date` (as today), `quantity` positive integer if given, `start_time` `isValidTime` if given, `duration` (default 1) > 0, multiple of 0.5. Query active items (`type` bound), `dayHires` for all their ids, `propertyNow` once; `now = date === today ? nowMinutes : null`. Per item: with `start_time` → skip if no `price_per_hour`, `!fitsHours`, or `start < now`; `available_quantity = quantity − peakUse`. Without → whole-day `available_quantity`; items with `price_per_hour` get `start_times = startTimes(item, hires, duration, quantity || 1, now)`. Apply the quantity filter as noted above. Keep `ORDER BY e.type, e.name`.

- [ ] **Step 4: Run — expect `ok`**

- [ ] **Step 5: Commit** — `git commit -am "Equipment: search by time window and list bookable start times"`

---

### Task 5: Swagger, MCP tools, ship

**Files:**
- Modify: `src/docs/swagger.js:604-621`
- Modify: `mcp-server/tools.js:1315-1347`, and `create_equipment_hire`'s schema if it lacks `start_time`
- Test: `scripts/check-equipment.js`

- [ ] **Step 1: Add the failing check** — `POST /api/mcp` `tools/list` (copy the courses check's request) contains `"open_time"`, `"slot_interval_minutes"` and, under `search_equipment`, `"start_time"`.

- [ ] **Step 2: Update docs and tools**

Swagger: `open_time`/`close_time` (`string`, `HH:MM`, nullable, "both or neither; null clears on PUT"), `slot_interval_minutes` (integer 5–240, default 60) on POST/PUT `/api/equipment`; `start_time`, `duration` params and the `start_times` shape on `/search`; `start_time` on POST `/hires`; 409 on PUT `/hires/{id}` ("reinstating into a full window"). MCP: `create_equipment`/`update_equipment` gain `open_time: z.string().nullable().optional()`, `close_time` (same), `slot_interval_minutes: z.number().int().optional()`; `search_equipment` gains `start_time: z.string().optional()`, `duration: z.number().optional()` and says it returns `start_times` per hourly item.

- [ ] **Step 3: Run the whole script — expect `all passed`.** Count requests on `KEY`; if over ~90, split the hire checks onto a second throwaway property's key (100/min limit).

- [ ] **Step 4: Commit** — `git commit -am "Equipment: document time windows in Swagger and MCP tools"`

- [ ] **Step 5: Ask the user** before applying the migration live (`node scripts/run-migration.js src/db/migrate-2026-10-16-equipment-hours.sql` — local already done, idempotent) and before `git push`. The migration must land **before** the push: `createEquipment`/`updateEquipment` write the new columns and 500 without them.
