# Housekeeping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Room housekeeping for hotel properties: daily job board, timed cleans, optional per-item inspection with fail alerts, arrival extras, marketable minibar lists with folio charges, a check-in warning, and a separate guest cleanliness rating form.

**Architecture:** One new module behind `property.enabled_modules ? 'housekeeping'`. Tables prefixed `hk_` and `minibar_`. Rules and DB helpers live in `src/lib/housekeeping.js` and `src/lib/minibar.js`. A single controller and router at `/api/housekeeping` serve the staff app. Small hooks go into bookings (checkout/check-in), extras, folio and property. Live updates go out on Ably `property:{id}:housekeeping`. The rating email runs from an in-process sweep like `reviewRequester`.

**Tech Stack:** Node 22, Express 4, pg, Ably REST, Resend, `@vercel/blob` (public photo uploads, same as `marinaDocuments.putPublic`), Clerk backend client for staff names.

**Spec:** `docs/superpowers/specs/2026-10-31-housekeeping-design.md`

## Global Constraints

- Rooms only. Never touch `room.status`, `room_availability` or the materialised view. Housekeeping state is not availability.
- **Opt-in module:** housekeeping is active only when `property.enabled_modules` is a JSON array containing `'housekeeping'`. A `NULL` `enabled_modules` (the default "everything on") does **not** turn housekeeping on. Otherwise every existing property would start blocking check-ins. All hooks outside `/api/housekeeping` (checkout→dirty, check-in 409, rating sweep) check this with `housekeepingEnabled(db, propertyId)`.
- Permissions: inspection writes take `requirePermission('housekeeping.inspect')`. Checklist, settings and minibar catalogue/list writes take `requirePermission('housekeeping.manage')`. Everything else uses `authenticateOrApiKey` with no permission. Don't add names to `src/lib/permissions.js`; both already exist.
- Room `housekeeping_status` ∈ `dirty | cleaning | clean | ready`, default `ready`.
- Job `kind` ∈ `checkout | stayover | arrival | extra`. Job `status` ∈ `open | claimed | in_progress | done | passed | failed | skipped`.
- Inspection scores are integers 1–5. An item passes when `score >= pass_mark`.
- Included minibar items are never charged, at any quantity.
- Check-in warning: `409 { error: 'Room not ready', housekeeping_status }` unless `force: true`.
- Ably payloads are full joined rows, never partial (see `bookings.js:419`).
- Errors are `{ error }` JSON via `next(err)`. 400 validation, 403 missing permission, 404 not found, 409 conflict.
- Live migration runs before pushing (OTA main auto-deploys). The plan only writes the file; applying it to live needs Robert's OK.

## Review Focus

1. **Property without housekeeping explicitly enabled** (including `enabled_modules IS NULL`): checking out never dirties a room, check-in never returns 409, and no rating email is sent. (Task 5, Task 7)
2. **Board fetched twice, or a booking cancelled after its job exists:** no duplicate jobs. An `open` or `claimed` job whose booking is now cancelled is marked `skipped` on the next fetch. (Task 2)
3. **Inspection body missing an active checklist item, with a score outside 1–5, or for a job that isn't `done`:** 400 / 400 / 409, and nothing is written. (Task 4)
4. **App retries a minibar recording:** the same job's usage is *replaced*, never doubled on the folio. (Task 6)
5. **Board "today" near midnight:** the date comes from the property's timezone, not UTC. A property in `Pacific/Auckland` gets its local date. (Task 2)

---

## File map

| File | Responsibility |
|---|---|
| `src/db/migrate-2026-10-31-housekeeping.sql` (create) | All new tables and columns, idempotent |
| `src/db/schema.sql` (modify) | Same definitions for fresh installs |
| `src/lib/housekeeping.js` (create) | Pure rules, `housekeepingEnabled`, `propertyToday`, `ensureJobs`, `fetchJob`, `staffName`, room status writes |
| `src/lib/minibar.js` (create) | List resolution (rate plan replaces room type), usage recording |
| `src/lib/cleanlinessRatings.js` (create) | Rating sweep, form HTML, record, opt-out |
| `src/controllers/housekeeping.js` (create) | All `/api/housekeeping` handlers |
| `src/routes/housekeeping.js` (create) | Routes and gates |
| `src/routes/cleanliness.js` (create) | Public guest form (no auth) |
| `src/lib/ably.js` (modify) | `publishHousekeeping(propertyId, event, payload)` |
| `src/lib/resend.js` (modify) | `sendCleanlinessRequest` |
| `src/lib/folio.js` (modify) | `minibar` folio lines |
| `src/controllers/bookings.js` (modify) | checkout → dirty, check-in 409 |
| `src/controllers/extras.js` (modify) | `place_in_room` on create/update |
| `src/controllers/property.js` (modify) | `'housekeeping'` in `MODULE_KEYS` |
| `src/app.js`, `src/server.js` (modify) | Mount routes, start sweep |
| `src/docs/swagger.js` (modify) | Document every new path |
| `scripts/check-housekeeping.js` (create) | One check script, one section per task |

The check script follows `scripts/check-permissions.js`: delete `RESEND_API_KEY`/`ABLY_API_KEY`, refuse remote DBs, drive controllers with the same `call(fn, req)` helper (bearer routes can't be reached without a real Clerk token), build fixtures under a throwaway property with `enabled_modules = '["rooms","housekeeping"]'`, and delete them in `finally`. Requests set `req.property_id`, `req.user = { id, role }`, `req.auth_method = 'bearer'`. Run with `node -r dotenv/config scripts/check-housekeeping.js`. Expected: every line `ok`, exit 0.

---

### Task 1: Schema, module key, pure rules

**Files:**
- Create: `src/db/migrate-2026-10-31-housekeeping.sql`, `src/lib/housekeeping.js`, `scripts/check-housekeeping.js`
- Modify: `src/db/schema.sql` (append housekeeping section after the extras tables ~line 366), `src/controllers/property.js:19`

**Interfaces:**
- Produces (tables, exact columns):
  - `property`: `hk_inspection_required BOOLEAN NOT NULL DEFAULT false`, `hk_service_every_days INT CHECK (> 0)`, `hk_linen_every_days INT CHECK (> 0)`
  - `room.housekeeping_status VARCHAR(20) NOT NULL DEFAULT 'ready'` + CHECK on the four values
  - `extra.place_in_room BOOLEAN NOT NULL DEFAULT false`; `booking_extra.placed_at TIMESTAMPTZ`, `booking_extra.placed_by VARCHAR(100)`
  - `hk_job(id, property_id, room_id, date DATE, kind, booking_id NULL, arriving_booking_id NULL, status DEFAULT 'open', claimed_by VARCHAR(100), claimed_by_name VARCHAR(200), linen_due BOOLEAN NOT NULL DEFAULT false, created_at)`, `UNIQUE (room_id, date, kind)`, CHECKs on kind/status, index `(property_id, date)`
  - `hk_clean(id, job_id → hk_job ON DELETE CASCADE, cleaner_id, cleaner_name, started_at NOT NULL DEFAULT now(), finished_at, sheets_changed BOOLEAN, towels_changed BOOLEAN, comments TEXT)`, index on `job_id`
  - `hk_override(property_id, room_id, date, action CHECK IN ('skip','clean'), created_by, created_at, PRIMARY KEY (room_id, date))`
  - `hk_check_item(id, property_id, name VARCHAR(100) NOT NULL, pass_mark INT NOT NULL CHECK 1..5, sort_order INT NOT NULL DEFAULT 0, status DEFAULT 'active' CHECK IN ('active','archived'))`
  - `hk_inspection(id, job_id → hk_job ON DELETE CASCADE, clean_id → hk_clean, inspector_id, inspector_name, passed BOOLEAN NOT NULL, score NUMERIC(3,2) NOT NULL, created_at)`
  - `hk_inspection_score(inspection_id → hk_inspection ON DELETE CASCADE, item_id → hk_check_item, item_name, pass_mark INT, score INT NOT NULL CHECK 1..5, comment TEXT, photo_url TEXT)`
  - `minibar_item(id, property_id, name VARCHAR(100) NOT NULL, description TEXT, image_url TEXT, price NUMERIC(10,2) NOT NULL CHECK >= 0, status DEFAULT 'active')`
  - `minibar_list_item(id, room_type_id → room_type, rate_plan_id → rate_plan NULL, minibar_item_id → minibar_item, quantity INT NOT NULL DEFAULT 1 CHECK > 0, included BOOLEAN NOT NULL)`; unique index on `(room_type_id, COALESCE(rate_plan_id, '00000000-0000-0000-0000-000000000000'::uuid), minibar_item_id)`
  - `minibar_usage(id, booking_id → booking, job_id → hk_job NULL, minibar_item_id, item_name, quantity INT CHECK > 0, unit_price NUMERIC(10,2) NOT NULL, recorded_by, created_at)`, index on `booking_id`
  - `cleanliness_rating(id, property_id, booking_id UNIQUE → booking, email, token TEXT UNIQUE NOT NULL, status DEFAULT 'pending' CHECK IN ('pending','sent','failed'), attempts INT DEFAULT 0, sent_at, rating INT CHECK 1..5, comment TEXT, rated_at, created_at)`
- Produces (pure functions, `src/lib/housekeeping.js`):
  - `nightIndex(checkIn: 'YYYY-MM-DD', date: 'YYYY-MM-DD') -> int` (days from check-in)
  - `stayoverDue(n: int, everyDays: int|null) -> boolean`: `everyDays != null && n > 0 && n % everyDays === 0`
  - `linenDue(n, everyDays) -> boolean`: same rule
  - `scoreInspection(items: [{id, name, pass_mark}], scores: [{item_id, score, comment?, photo_url?}]) -> { error } | { passed, score, rows }`. `error` when any active item is missing, an unknown `item_id` is sent, an item is duplicated, or a score isn't an integer 1–5. `score` is the mean rounded to 2 dp. `rows` snapshot `item_name` and `pass_mark`.
  - `statusAfterFinish(kind, inspectionRequired) -> 'clean'|'ready'`: `'clean'` only for `checkout` with inspection required, `'ready'` otherwise.

- [ ] **Step 1: Write the failing checks** in `scripts/check-housekeeping.js` section "Task 1":
```js
assert.equal(nightIndex('2030-07-01', '2030-07-03'), 2);
assert.equal(stayoverDue(2, 2), true); assert.equal(stayoverDue(3, 2), false);
assert.equal(stayoverDue(0, 1), false); assert.equal(stayoverDue(2, null), false);
const items = [{ id: 'a', name: 'Floor', pass_mark: 4 }, { id: 'b', name: 'Bath', pass_mark: 3 }];
assert.deepEqual(scoreInspection(items, [{ item_id: 'a', score: 4 }, { item_id: 'b', score: 3 }]).passed, true);
const f = scoreInspection(items, [{ item_id: 'a', score: 3, comment: 'hair' }, { item_id: 'b', score: 5 }]);
assert.equal(f.passed, false); assert.equal(f.score, 4); assert.equal(f.rows[0].item_name, 'Floor');
assert.match(scoreInspection(items, [{ item_id: 'a', score: 4 }]).error, /Bath/);
assert.match(scoreInspection(items, [{ item_id: 'a', score: 6 }, { item_id: 'b', score: 3 }]).error, /1.+5/);
assert.ok(scoreInspection(items, [{ item_id: 'a', score: 4 }, { item_id: 'a', score: 4 }, { item_id: 'b', score: 3 }]).error);
assert.equal(statusAfterFinish('checkout', true), 'clean');
assert.equal(statusAfterFinish('checkout', false), 'ready');
assert.equal(statusAfterFinish('stayover', true), 'ready');
```
Plus a DB check: after the migration, `room.housekeeping_status` defaults to `'ready'` on a fresh room insert, and running the migration file a second time (`pool.query(fs.readFileSync(...))`) succeeds.
- [ ] **Step 2: Run, expect FAIL** (`Cannot find module '../src/lib/housekeeping'`).
- [ ] **Step 3: Write the migration** (header comment in the style of `migrate-2026-10-31-permissions.sql`; `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). Mirror it into `schema.sql`. Add `'housekeeping'` to `MODULE_KEYS`. Implement the pure functions. Apply locally: `node scripts/run-migration.js src/db/migrate-2026-10-31-housekeeping.sql` with `DATABASE_URL_LIVE` **unset** in the shell (the runner also hits live when it's set).
- [ ] **Step 4: Run, expect all `ok`.**
- [ ] **Step 5: Commit** `Housekeeping: schema, module key, inspection and stayover rules`.

---

### Task 2: Jobs, board, overrides, settings, manual room status

**Files:**
- Modify: `src/lib/housekeeping.js`, `src/lib/ably.js`
- Create: `src/controllers/housekeeping.js`, `src/routes/housekeeping.js`
- Modify: `src/app.js` (mount `app.use('/api/housekeeping', housekeepingRoutes)` next to `/api/extras`)

**Interfaces:**
- Consumes: Task 1 tables and `stayoverDue`, `linenDue`, `nightIndex`.
- Produces:
  - `housekeepingEnabled(db, propertyId) -> Promise<boolean>`: `enabled_modules IS NOT NULL AND enabled_modules ? 'housekeeping'`
  - `propertyToday(db, propertyId) -> Promise<'YYYY-MM-DD'>`: `(now() AT TIME ZONE COALESCE(p.timezone,'UTC'))::date`
  - `ensureJobs(db, propertyId, date) -> Promise<void>`: idempotent
  - `fetchJob(db, jobId, propertyId) -> Promise<row|null>`: the joined board row (shape below)
  - `setRoomStatus(db, propertyId, roomId, status) -> Promise<room|null>`: publishes `room-status-changed` with the full room row
  - `staffName(userId) -> Promise<string|null>`: `clerkClient.users.getUser`, `"First Last"`, cached in a module-level `Map`, `null` on error. Called as `module.exports.staffName` so the check can stub it.
  - `ably.publishHousekeeping(propertyId, event, payload)` on channel `property:${propertyId}:housekeeping`, no-op without a client
  - Routes:
    - `GET /board?date=` (default `propertyToday`)
    - `GET /settings`, `PUT /settings` (manage) `{ inspection_required, service_every_days, linen_every_days }`
    - `PUT /overrides` `{ room_id, date, action: 'skip'|'clean' }`, `DELETE /overrides/:room_id/:date`
    - `PUT /rooms/:room_id/status` `{ housekeeping_status }`

`ensureJobs` returns without doing anything, and `GET /board` returns `[]`, when `housekeepingEnabled` is false.

**ensureJobs rules** (one transaction; every INSERT is `ON CONFLICT (room_id, date, kind) DO NOTHING`; "live" booking status = `confirmed | checked_in | checked_out`):
1. `checkout`: live bookings with `check_out = date`. `booking_id` = the departing booking, `arriving_booking_id` = a live booking on the same room with `check_in = date`, `linen_due = true`.
2. `stayover`: bookings `confirmed | checked_in` with `check_in < date < check_out`, when `stayoverDue(nightIndex)` with the property's `hk_service_every_days`, and no `skip` override for room+date. `linen_due = linenDue(n, hk_linen_every_days)`.
3. `extra`: each `clean` override for the date. `booking_id` = the in-house booking if there is one.
4. `arrival`: live bookings with `check_in = date` on a room with no `checkout` job that date, when the booking has at least one `booking_extra` whose extra has `place_in_room`.
5. Cleanup: `open`/`claimed` jobs for the date whose `booking_id` (or, for arrival jobs, `arriving_booking_id`) is no longer live, or that have a `skip` override → `status = 'skipped'`.

**Board row shape** (`fetchJob` and `GET /board` return the same shape, an array ordered by `arriving_booking_id IS NOT NULL AND room.housekeeping_status <> 'ready'` desc, then kind `checkout, arrival, extra, stayover`, then `room_number`):
`{ id, date, kind, status, linen_due, claimed_by, claimed_by_name, room: { id, room_number, floor, housekeeping_status, room_type_id, room_type_name }, departing: { booking_id, guest_name } | null, arriving: { booking_id, guest_name, arrival_time } | null, extras_to_place: [{ booking_extra_id, name, quantity, placed_at, placed_by }], minibar: <minibar.resolveList for the in-house/departing booking's room type + rate plan, [] until Task 6>, last_cleaner: { id, name } | null, stay_cleaner: { id, name } | null, attempts: [hk_clean rows], inspections: [hk_inspection rows with scores] }`. `arrival_time` = `booking.metadata->>'arrival_time'`. `last_cleaner` = the newest finished `hk_clean` on that room before this job. `stay_cleaner` = the cleaner with the most finished cleans on jobs whose `booking_id` is the current in-house/departing booking.

- [ ] **Step 1: Write failing checks** ("Task 2"), with fixtures: property in `Pacific/Auckland`, rooms 101–104, a guest, bookings that give one departure+arrival on 101, a 4-night stay on 102 with `hk_service_every_days = 2`, `hk_linen_every_days = 4`, and an arrival with a `place_in_room` extra on empty room 103:
  - `GET /board?date=D` returns jobs `{101: checkout (arriving set), 102: stayover on night 2 only, 103: arrival}`, and none for 104.
  - Calling it twice gives the same job count (no duplicates).
  - A `skip` override on 102 makes its job `skipped`. A `clean` override on 104 adds an `extra` job.
  - Cancelling 101's departing booking, then fetching again, makes its `open` job `skipped`.
  - `propertyToday` for the Auckland property equals `new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(new Date())`.
  - `PUT /rooms/:id/status` with `'filthy'` → 400. `'dirty'` → 200 and `room.housekeeping_status = 'dirty'`.
  - `PUT /settings` `{ service_every_days: 0 }` → 400.
  - `housekeepingEnabled` is false for `enabled_modules NULL` and true for `["housekeeping"]`.
  - `GET /board` on a property with `enabled_modules NULL` and a departing booking → `[]`, and no `hk_job` rows created.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the lib functions, the Ably helper, the controller handlers (`board`, `getSettings`, `putSettings`, `putOverride`, `deleteOverride`, `putRoomStatus`) and the router. Every handler checks that the room and booking belong to `req.property_id`. Publish `job-updated` (full `fetchJob` row) for jobs that `ensureJobs` creates or skips.
- [ ] **Step 4: Run, expect all `ok`.**
- [ ] **Step 5: Commit** `Housekeeping: job board, stayover rule, overrides, settings`.

---

### Task 3: Clean lifecycle — claim, start, finish

**Files:** Modify `src/controllers/housekeeping.js`, `src/routes/housekeeping.js`, `src/lib/housekeeping.js`.

**Interfaces:**
- Consumes: `fetchJob`, `setRoomStatus`, `staffName`, `statusAfterFinish`, `publishHousekeeping`.
- Produces routes (each returns the `fetchJob` row and publishes `job-updated`):
  - `POST /jobs/:id/claim`: from `open` → `claimed`, sets `claimed_by`/`claimed_by_name` to the caller. 409 `{ error: 'Already claimed', claimed_by_name }` if someone else claimed it, unless `{ force: true }` (lets someone take over an abandoned room).
  - `DELETE /jobs/:id/claim`: `claimed` → `open`, clears the claim. Only the claimer or an admin.
  - `POST /jobs/:id/start`: allowed from `open | claimed | failed`. Inserts an `hk_clean` attempt for the caller, job → `in_progress`, claims for the caller, room → `cleaning`. 409 from any other status.
  - `POST /jobs/:id/finish` `{ sheets_changed: boolean, towels_changed: boolean, comments?: string ≤ 2000 }`: only from `in_progress` and only by the attempt's cleaner (or an admin). Sets `finished_at = now()`, job → `done`, room → `statusAfterFinish(kind, property.hk_inspection_required)`. Non-boolean linen flags → 400.

- [ ] **Step 1: Failing checks** ("Task 3"):
  - Claim by A, then claim by B → 409 naming A. Claim by B with `force` → B.
  - Start → room `cleaning` and one attempt.
  - Finish by B on A's attempt → 403.
  - Finish with `sheets_changed: 'yes'` → 400.
  - Finish by the right cleaner → job `done`, attempt `finished_at` set. Room is `ready` when `hk_inspection_required = false`, and `clean` when it is true (checkout job). A stayover finish is `ready` either way.
  - Start on a `done` job → 409.
  - Stub `housekeeping.staffName = async (id) => 'Name ' + id`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Do each transition as `UPDATE … WHERE id = $1 AND property_id = $2 AND status = ANY($3) RETURNING`, so two taps can't both win. Zero rows → 409.
- [ ] **Step 4: Run, expect all `ok`.**
- [ ] **Step 5: Commit** `Housekeeping: claim, start and finish cleans`.

---

### Task 4: Inspection — checklist, photos, inspect, fail alert

**Files:** Modify `src/controllers/housekeeping.js`, `src/routes/housekeeping.js`, `src/lib/housekeeping.js`.

**Interfaces:**
- Consumes: `scoreInspection`, `fetchJob`, `setRoomStatus`, `requirePermission` from `src/middleware/auth.js`.
- Produces routes:
  - `GET /check-items` (any staff), `POST /check-items` and `PUT /check-items/:id` (`housekeeping.manage`), `{ name, pass_mark, sort_order, status }`. `pass_mark` must be an integer 1–5. Archived items drop out of new inspections and old score rows are untouched.
  - `POST /photos` (`housekeeping.inspect`): raw body via `express.raw({ type: ['image/jpeg','image/png','image/webp'], limit: '5mb' })` on this route only. Calls `housekeeping.putPhoto(pathname, buf, contentType)`, a seam that defaults to `@vercel/blob` `put` with `access: 'public'`, `BLOB_PUBLIC_READ_WRITE_TOKEN`, `addRandomSuffix: true` (same call as `marinaDocuments.putPublic`), under `housekeeping/${propertyId}/`. Returns `201 { url }`. Wrong or missing content type → 400.
  - `POST /jobs/:id/inspections` (`housekeeping.inspect`) `{ scores: [{ item_id, score, comment?, photo_url? }] }`:
    - Job must be `done`, or `passed` (a later spot check). Otherwise 409.
    - The inspector may not be the cleaner of the latest attempt, unless they're an admin: 409 `{ error: 'Cannot inspect your own clean' }`. *(Plan call: the permissions spec left this to housekeeping.)*
    - Uses `scoreInspection` against active items; `error` → 400 and nothing is written.
    - In one transaction, inserts `hk_inspection` (with `clean_id` = latest attempt) and the score rows.
    - Pass → job `passed`, room `ready`.
    - Fail → job `failed`, room `dirty`, and publish `inspection-failed` with `{ cleaner_id, cleaner_name, job: fetchJob row, failed_items: [{ item_name, score, pass_mark, comment, photo_url }] }`.
    - Returns `201` with the job row.
  - The attempt and inspection history on the board row comes from Task 2's `fetchJob`.

- [ ] **Step 1: Failing checks** ("Task 4"):
  - Staff without a grant → 403 `{ permission: 'housekeeping.inspect' }` (drive `requirePermission('housekeeping.inspect')` with the `mw` helper from `check-permissions.js`).
  - Staff with a grant via `setGrant` → passes.
  - Inspecting an `in_progress` job → 409.
  - Body missing an active item → 400, and `hk_inspection` count unchanged.
  - Self-inspection by the non-admin cleaner → 409. An admin → allowed.
  - Failing "Floor" (pass mark 4) at 3 with comment and photo → job `failed`, room `dirty`. Capture the payload by stubbing `ably.publishHousekeeping`: its `failed_items` holds exactly the Floor row with comment and photo_url.
  - Restart → finish → pass → job `passed`, room `ready`, two inspections in `fetchJob(...).inspections`.
  - `POST /photos` with `text/plain` → 400. With `image/jpeg` and `putPhoto` stubbed → 201 url.
  - Archiving an item leaves earlier `hk_inspection_score.item_name` intact.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect all `ok`.**
- [ ] **Step 5: Commit** `Housekeeping: checklist inspections with fail alerts and photos`.

---

### Task 5: Booking hooks and arrival extras

**Files:** Modify `src/controllers/bookings.js` (`updateBooking`, ~lines 396–425), `src/controllers/extras.js` (`createExtra`, `updateExtra`), `src/controllers/housekeeping.js`, `src/routes/housekeeping.js`.

**Interfaces:**
- Consumes: `housekeepingEnabled`, `setRoomStatus`, `ensureJobs`, `propertyToday`.
- Produces:
  - Check-in gate: in `updateBooking`, beside the folio gate. When `status === 'checked_in' && statusBefore !== 'checked_in' && req.body.force !== true && await housekeepingEnabled(pool, req.property_id)` and the booking's room `housekeeping_status !== 'ready'` → `409 { error: 'Room not ready', housekeeping_status }`.
  - Checkout hook: after the UPDATE, when the status moved to `checked_out` and housekeeping is enabled → `setRoomStatus(pool, property, room, 'dirty')`, then `ensureJobs(pool, property, propertyToday)`. Fire-and-forget with `.catch(console.error)`, like the Ably publish there.
  - `extra.place_in_room` accepted (boolean, else 400) on `POST /api/extras` and `PUT /api/extras/:id`.
  - `POST /api/housekeeping/booking-extras/:id/placed`: sets `placed_at = now()`, `placed_by = caller`. Idempotent (a second call keeps the first timestamp). 404 if the booking isn't in this property. Publishes `job-updated` for the job(s) showing it.

- [ ] **Step 1: Failing checks** ("Task 5"):
  - Housekeeping-enabled property, room `dirty`: `PUT` booking to `checked_in` → 409 `Room not ready`. With `force: true` → 200.
  - Same flow on a second throwaway property with `enabled_modules = NULL` and a dirty room → 200 (no gate).
  - Checking out on the enabled property → room `dirty` (await a short poll, or export and await the hook function directly). On the NULL property → room stays `ready`.
  - Create an extra with `place_in_room: 'x'` → 400. With `true`, booked onto an arrival → appears in the board row's `extras_to_place`. `placed` twice → same `placed_at`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Put the checkout hook in a named function `onCheckedOut(propertyId, roomId)` in `src/lib/housekeeping.js` so the check can await it.
- [ ] **Step 4: Run, expect all `ok`.** Also re-run `node -r dotenv/config scripts/check-rate-plans.js` (it exercises `updateBooking`) and expect no new failures.
- [ ] **Step 5: Commit** `Housekeeping: check-in warning, checkout makes the room dirty, arrival extras`.

---

### Task 6: Minibar — catalogue, lists, public read, usage, folio

**Files:** Create `src/lib/minibar.js`. Modify `src/controllers/housekeeping.js`, `src/routes/housekeeping.js`, `src/lib/folio.js`, `src/lib/housekeeping.js` (board `minibar` field).

**Interfaces:**
- Produces:
  - `resolveList(db, roomTypeId, ratePlanId|null) -> Promise<[{ minibar_item_id, name, description, image_url, price, quantity, included }]>`. If any active rows exist for `(roomTypeId, ratePlanId)` with a non-null plan, return only those. Otherwise return the room type's rows with `rate_plan_id IS NULL`. Archived items are excluded. Order by name.
  - `recordUsage(db, { propertyId, job, items: [{ minibar_item_id, quantity }], userId }) -> Promise<rows>`: inside a transaction, `DELETE FROM minibar_usage WHERE job_id = $1`, then insert. `unit_price` is `0` when the item is `included` on the resolved list for the booking's room type and `booking.rate_plan_id`, and the item's current `price` otherwise. Quantity 0 rows are skipped.
  - Routes:
    - `GET /minibar/items` (any), `POST /minibar/items`, `PUT /minibar/items/:id` (manage).
    - `PUT /minibar/lists` (manage) `{ room_type_id, rate_plan_id|null, items: [{ minibar_item_id, quantity, included }] }` replaces that list. Room type, rate plan (must belong to that room type) and items must belong to the property, else 400.
    - `GET /minibar/list?room_type_id=&rate_plan_id=` with `authenticateOrApiKey` and no permission (the booking site's property key) → `resolveList`.
    - `PUT /jobs/:id/minibar` `{ items }` → `recordUsage` for the job's `booking_id`. 400 if the job has none (arrival-only jobs). Publishes `minibar-recorded` with the job row.
  - Folio: a fifth query in `computeFolio` over `minibar_usage` where `unit_price > 0`. Items `{ type: 'minibar', source_id, description: qty > 1 ? \`${name} × ${qty}\` : name, amount, created_at }`. Nothing else in `folio.js` changes, so a checked-out guest's late charge simply raises `balance`.

- [ ] **Step 1: Failing checks** ("Task 6"):
  - Room type list: Prosecco (charged 30) and Chocolate (included). Flex plan list: Prosecco included.
  - `resolveList(rt, null)` → 2 items. `resolveList(rt, flex)` → only the Flex rows. `resolveList(rt, saver)`, where Saver has no list → the room type list.
  - On a Saver booking, recording Prosecco ×2 and Chocolate ×5 → folio has one `minibar` line `Prosecco × 2` amount `60.00`, and no chocolate line.
  - Recording the same job again with Prosecco ×1 → the folio minibar line is `30.00` (replaced, not added).
  - On a Flex booking, Prosecco ×3 → no minibar folio line.
  - Recording on a checked-out booking raises `balance` by the charge.
  - `PUT /minibar/lists` with another property's item → 400.
  - The public `GET /minibar/list` passes through `authenticateOrApiKey` with a full key (drive with `mw`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Fill the board's `minibar` field with `resolveList` for the job's booking.
- [ ] **Step 4: Run, expect all `ok`.** Then run `node -r dotenv/config scripts/check-rate-plans.js` again (folio is shared) and expect no new failures.
- [ ] **Step 5: Commit** `Housekeeping: minibar lists per room type and rate plan, usage on the folio`.

---

### Task 7: Guest cleanliness rating

**Files:** Create `src/lib/cleanlinessRatings.js`, `src/routes/cleanliness.js`. Modify `src/lib/resend.js`, `src/app.js` (`app.use('/api/cleanliness', require('./routes/cleanliness'))` next to `/api/review-opt-out`; the router applies `express.urlencoded({ extended: false })` itself), `src/server.js` (`startCleanlinessRatingJob()`).

**Interfaces:**
- Produces:
  - `claimDue(db, now: Date) -> Promise<rows>`: inserts `cleanliness_rating` rows (`token = crypto.randomBytes(24).toString('base64url')`, `email = lower(trim(guest.email))`) for bookings with `status = 'checked_out'`, `check_out` between `(now in property tz)::date - 2` and `(now in property tz)::date` (never backfills), a housekeeping-enabled property, a guest email, and no row in `review_request_opt_out` for (property, email). `ON CONFLICT (booking_id) DO NOTHING RETURNING *`. Takes `now` so the check can move the clock.
  - `runOnce(now = new Date())`: claims, then sends each row via `resend.sendCleanlinessRequest({ to, name, propertyName, branding, formUrl, optOutUrl, idempotencyKey: 'cleanliness-' + id })`. Success → `status 'sent'`, `sent_at`. Error → `attempts + 1`, `'failed'` after 3 (mirror `reviewRequester`'s `MAX_ATTEMPTS`). Branding from `spa.resolveEmailBranding(propertyId)` as `reviewRequester` does.
  - `startCleanlinessRatingJob()`: boot plus every 15 minutes, same pattern as `startReviewRequestJob`.
  - URLs: `formUrl = ${OTA_API_BASE_URL}/api/cleanliness/${token}`, `optOutUrl = ${formUrl}/opt-out`. Reuse the `OTA_API_BASE_URL` constant from `reviewRequester` (export it, don't copy).
  - Public routes, no auth:
    - `GET /:token` → HTML page with the property name, five radio buttons labelled 1–5, an optional comment textarea (≤ 2000 chars) and a submit button. Plain inline-styled HTML, `escapeHtml` every value.
    - `POST /:token` (urlencoded) → validates `rating` as an integer 1–5 (else 400 HTML), stores `rating`, `comment`, `rated_at = now()`. A resubmission overwrites. Returns a thank-you page.
    - `GET /:token/opt-out` → inserts into `review_request_opt_out (property_id, email)` `ON CONFLICT DO NOTHING`, returns a confirmation page.
    - Unknown token → 404 page.
  - `resend.sendCleanlinessRequest`: same skeleton as `sendReviewRequest`. Subject `How clean was your room at ${propertyName}?`, a one-line note, a CTA button "Rate your room", and the unsubscribe footer.
  - Report credit (used in Task 8): a rating counts for the cleaner of the latest finished attempt on the `checkout` job for that room dated `<=` the booking's `check_in` (excluding failed attempts), **plus** each distinct cleaner of finished `stayover`/`extra` jobs on that booking. Each counts the rating once, unweighted. *(Plan call: the spec left the weighting to the builder.)*

- [ ] **Step 1: Failing checks** ("Task 7"), with `resend.sendCleanlinessRequest` stubbed to capture calls:
  - A checked-out booking on an enabled property → one claim and one send. `runOnce` again → no second send.
  - The same setup on a NULL-modules property → no claim.
  - A guest in `review_request_opt_out` → no claim.
  - `check_out` five days ago → no claim.
  - Over HTTP (the app on an ephemeral port, as `check-rate-plans.js` does):
    - `GET /api/cleanliness/<token>` → 200 HTML containing the property name.
    - `POST` with `rating=7` → 400.
    - `rating=4&comment=great` → 200 and the row is stored. Posting `rating=2` → the row is overwritten to 2.
    - `GET /api/cleanliness/nope` → 404.
    - `GET …/opt-out` → an opt-out row exists.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect all `ok`.** Re-run `node -r dotenv/config scripts/check-review-requests.js` and expect no new failures.
- [ ] **Step 5: Commit** `Housekeeping: guest cleanliness rating email and form`.

---

### Task 8: Reports and swagger

**Files:** Modify `src/controllers/housekeeping.js`, `src/routes/housekeeping.js`, `src/docs/swagger.js`.

**Interfaces:**
- Produces: `GET /reports?from=&to=` (`YYYY-MM-DD`, `to` exclusive, both required, else 400) → `{ cleaners: [row], rooms: [row] }`. Each row has `{ id, name | room_number, jobs_done, avg_minutes, median_minutes, avg_inspection_score, first_time_pass_rate, avg_guest_score }`.
  - Minutes come from finished attempts (`finished_at - started_at`) on jobs dated in range. Median uses `percentile_cont(0.5)`.
  - `first_time_pass_rate` = among jobs with at least one inspection, the share whose first inspection passed. It is `null` when nothing was inspected.
  - `avg_guest_score` uses the Task 7 credit rule over ratings whose booking `check_out` falls in range.
  - Numbers are rounded to 2 dp, with `null` where there's no data.
- Swagger: every `/api/housekeeping/*` and `/api/cleanliness/*` path, with request bodies, the 403 `Missing permission` on gated routes, and the 409 `Room not ready` added to `PUT /api/bookings/{id}`. Follow the existing entries' style in `src/docs/swagger.js`.

- [ ] **Step 1: Failing checks** ("Task 8"): using the fixtures built so far, cleaner A's `jobs_done` and `avg_minutes` match hand-computed values (set `started_at`/`finished_at` directly in SQL for determinism). A's `first_time_pass_rate` is `0.5` after one fail-then-pass job and one pass job. `avg_guest_score` includes the Task 7 rating. A missing `to` → 400. The swagger spec object contains `'/api/housekeeping/board'` and `'/api/cleanliness/{token}'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the whole script, expect all `ok`, exit 0.**
- [ ] **Step 5: Commit** `Housekeeping: cleaner and room reports, swagger`.

---

## Shipping (after all tasks, not a task)

1. Ask Robert's OK, then apply `src/db/migrate-2026-10-31-housekeeping.sql` to live (through node with `DATABASE_URL_LIVE`, as for permissions).
2. Push main (auto-deploys). Smoke-test: `GET /api/housekeeping/board` returns `[]` for a property without the module, and no check-in on live returns `Room not ready`.
3. Nothing switches on until a property adds `'housekeeping'` to `enabled_modules`.
