# Book by Room Type (Race-Safe Room Selection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `POST /api/bookings` accept `room_type_id` as an alternative to `room_id`, atomically picking and reserving the first available room of that type, and make the database itself prevent overlapping bookings for any room (closing the same race for the existing `room_id` path too) — per `docs/superpowers/specs/2026-07-22-book-by-room-type-design.md`.

**Architecture:** A Postgres `EXCLUDE` constraint (via `btree_gist`) on `booking(room_id, daterange(check_in, check_out))` makes overlapping non-cancelled bookings for the same room impossible at the database level. `createBooking` is rewritten to build a list of one (`room_id`) or several (`room_type_id`, ordered by `room_number`) candidate rooms, and for each candidate attempts an insert inside a `SAVEPOINT`, catching the constraint violation (`23P01`) to try the next candidate.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL (`btree_gist` extension).

## Global Constraints

- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step is a **manual check** via `curl` against a running `npm run dev` server, with exact expected output.
- No load-testing tool exists either, so true concurrent-request races can't be manually demonstrated in this plan. Verification instead confirms the mechanism directly: attempting to book the same room over already-booked dates a second time must fail — proving the constraint is active and enforced, which is what makes the actual concurrent case safe.
- Two databases: local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance backing `https://ota-u6ii.onrender.com`. This plan changes both schema and code, so it needs a DB migration on both databases *and* a code push/redeploy.
- Confirm with the user before running the migration against `otadb` and before pushing to `origin/main` — per this project's established practice for any live-database write or code deploy.
- Today's date: **2026-07-22**. Use BBYC (property id `e1000000-0000-0000-0000-000000000004`, admin `admin@bbyc.example.com` / `Bbyc-dE3OSnze!1`) as the test property — its `Bungalow` room type (`a4000000-0000-0000-0000-000000000001`) has 6 active rooms (`b4000000-...0001`–`...0006`) with availability seeded through `2026-10-20`. Use the date range `2026-09-01`–`2026-09-03` for new test bookings in this plan — it's inside the seeded window and unused by any booking created in prior work this session (which used `2026-08-01`–`2026-08-03`, `2026-08-10`–`2026-08-12`, and `2026-08-15`–`2026-08-17`).
- Already confirmed (informational, not a step to redo): neither local nor `otadb` currently has any overlapping non-cancelled bookings for the same room, so the exclusion constraint will apply cleanly to existing data on both.

---

### Task 1: Add the exclusion constraint (schema + migration)

**Files:**
- Modify: `src/db/schema.sql:1-2` (extension) and `src/db/schema.sql:66-78` (`booking` table block)
- Create: `src/db/migrate-2026-07-22-booking-no-overlap.sql`

**Interfaces:**
- Produces: constraint `booking_no_overlap` on `booking`, enforcing no two non-cancelled rows share a `room_id` with overlapping `[check_in, check_out)` ranges. Task 2's `INSERT` relies on this raising Postgres error code `23P01` on violation.

- [ ] **Step 1: Enable the extension in `schema.sql`**

Replace:
```sql
-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```
with:
```sql
-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Enable btree_gist so the booking_no_overlap exclusion constraint below can
-- mix an equality column (room_id) with a range-overlap column (daterange)
-- in one GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

- [ ] **Step 2: Add the constraint to the `booking` table block in `schema.sql`**

Replace:
```sql
-- Bookings
CREATE TABLE IF NOT EXISTS booking (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  guest_id    UUID          NOT NULL REFERENCES guest(id),
  room_id     UUID          NOT NULL REFERENCES room(id),
  check_in    DATE          NOT NULL,
  check_out   DATE          NOT NULL,
  guests      INT           NOT NULL DEFAULT 1,
  total_price NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'confirmed',
  metadata    JSONB         NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ   DEFAULT now()
);
```
with:
```sql
-- Bookings
CREATE TABLE IF NOT EXISTS booking (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID          NOT NULL REFERENCES property(id),
  guest_id    UUID          NOT NULL REFERENCES guest(id),
  room_id     UUID          NOT NULL REFERENCES room(id),
  check_in    DATE          NOT NULL,
  check_out   DATE          NOT NULL,
  guests      INT           NOT NULL DEFAULT 1,
  total_price NUMERIC(10,2) NOT NULL,
  status      VARCHAR(20)   DEFAULT 'confirmed',
  metadata    JSONB         NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ   DEFAULT now(),
  EXCLUDE USING gist (room_id WITH =, daterange(check_in, check_out) WITH &&) WHERE (status <> 'cancelled')
);
```

- [ ] **Step 3: Write the migration file for `otadb`**

Create `src/db/migrate-2026-07-22-booking-no-overlap.sql`:
```sql
-- One-time migration: enable btree_gist and add an exclusion constraint on
-- booking preventing overlapping non-cancelled bookings for the same room.
-- Run ONCE directly against an already-populated database (NOT part of the
-- normal reset pipeline). Preconditioned on there being no existing
-- overlapping non-cancelled bookings - verified separately before running
-- this (see Task 4 Step 1). See
-- docs/superpowers/specs/2026-07-22-book-by-room-type-design.md.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE booking
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in, check_out) WITH &&
  )
  WHERE (status <> 'cancelled');
```

- [ ] **Step 4: Full reset and reseed — local**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-restaurant-bimini-betula-barry.sql', 'src/db/seed-restaurant-bbyc.sql', 'src/db/seed-extras.sql', 'src/db/seed-bbyc-rooms.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `done`, no errors (a fresh empty schema has no existing bookings, so the inline constraint can't fail validation here).

- [ ] **Step 5: Verify the constraint exists**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  const res = await client.query(\"SELECT conname FROM pg_constraint WHERE conname = 'booking_no_overlap'\");
  console.log(res.rows);
  await client.end();
})();
"
```
Expected: `[ { conname: 'booking_no_overlap' } ]`.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.sql src/db/migrate-2026-07-22-booking-no-overlap.sql
git commit -m "Add exclusion constraint preventing overlapping room bookings"
```

---

### Task 2: Rewrite `createBooking` to support `room_type_id` and the constraint-based retry

**Files:**
- Modify: `src/controllers/bookings.js:96-219` (`createBooking`)

**Interfaces:**
- Consumes: `booking_no_overlap` constraint from Task 1 (via Postgres error code `23P01` on `INSERT` violation).
- Produces: no change to `createBooking`'s export name or the shape of a successful `201` response — only its accepted request body (`room_type_id` as an alternative to `room_id`) and some error-path status/message details change (documented below).

- [ ] **Step 1: Replace `createBooking`**

Replace the full function (currently `src/controllers/bookings.js:96-219`, from `async function createBooking(req, res, next) {` through its closing `}`):

```js
async function createBooking(req, res, next) {
  const { guest_id, room_id, room_type_id, check_in, check_out, guests, metadata } = req.body;

  if (!guest_id || !check_in || !check_out || (!room_id && !room_type_id) || (room_id && room_type_id)) {
    return res.status(400).json({ error: 'guest_id, check_in, check_out, and exactly one of room_id or room_type_id are required' });
  }
  if (!isValidDate(check_in) || !isValidDate(check_out)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }
  if (check_in >= check_out) {
    return res.status(400).json({ error: 'check_in must be before check_out' });
  }
  if (metadata !== undefined && !isValidMetadata(metadata)) {
    return res.status(400).json({ error: 'metadata must be a JSON object' });
  }

  // Build set of required dates (shared by every candidate room)
  const required = new Set();
  const d = new Date(check_in);
  const end = new Date(check_out);
  while (d < end) {
    required.add(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const guestRes = await client.query(
      'SELECT id FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]
    );
    if (!guestRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Guest not found' });
    }

    let candidates;
    if (room_id) {
      const roomRes = await client.query(
        `SELECT r.id, r.status, rt.base_rate
         FROM room r JOIN room_type rt ON rt.id = r.room_type_id
         WHERE r.id = $1 AND r.property_id = $2`,
        [room_id, req.property_id]
      );
      if (!roomRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Room not found' });
      }
      if (roomRes.rows[0].status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Room is not active' });
      }
      candidates = [{ id: roomRes.rows[0].id, base_rate: roomRes.rows[0].base_rate }];
    } else {
      const typeRes = await client.query(
        'SELECT id FROM room_type WHERE id = $1 AND property_id = $2', [room_type_id, req.property_id]
      );
      if (!typeRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Room type not found' });
      }
      const roomsRes = await client.query(
        `SELECT r.id, rt.base_rate
         FROM room r JOIN room_type rt ON rt.id = r.room_type_id
         WHERE r.room_type_id = $1 AND r.property_id = $2 AND r.status = 'active'
         ORDER BY r.room_number`,
        [room_type_id, req.property_id]
      );
      candidates = roomsRes.rows;
    }

    let booked = null;
    let lastUnavailableDate = null;

    for (const candidate of candidates) {
      await client.query('SAVEPOINT attempt');

      const availRes = await client.query(
        `SELECT date, is_available, override_rate
         FROM room_availability
         WHERE room_id = $1 AND date >= $2 AND date < $3
         ORDER BY date`,
        [candidate.id, check_in, check_out]
      );
      const availMap = {};
      for (const row of availRes.rows) {
        availMap[row.date] = row;
      }

      let allAvailable = true;
      for (const date of required) {
        const entry = availMap[date];
        if (!entry || !entry.is_available) {
          allAvailable = false;
          lastUnavailableDate = date;
          break;
        }
      }

      if (!allAvailable) {
        await client.query('ROLLBACK TO SAVEPOINT attempt');
        continue;
      }

      let total = 0;
      const baseRate = parseFloat(candidate.base_rate);
      for (const date of required) {
        const entry = availMap[date];
        total += entry && entry.override_rate != null ? parseFloat(entry.override_rate) : baseRate;
      }

      try {
        const bookingRes = await client.query(
          `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, guests, total_price, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [req.property_id, guest_id, candidate.id, check_in, check_out, guests || 1, total.toFixed(2), metadata ?? {}]
        );
        await client.query('RELEASE SAVEPOINT attempt');
        booked = bookingRes.rows[0];
        break;
      } catch (err) {
        if (err.code === '23P01') {
          await client.query('ROLLBACK TO SAVEPOINT attempt');
          continue;
        }
        throw err;
      }
    }

    if (!booked) {
      await client.query('ROLLBACK');
      if (room_id) {
        return res.status(409).json({ error: lastUnavailableDate ? `Room not available on ${lastUnavailableDate}` : 'Room already booked for this period' });
      }
      return res.status(409).json({ error: 'No rooms of this type available for the requested dates' });
    }

    // Mark availability as unavailable
    await client.query(
      `UPDATE room_availability
       SET is_available = false
       WHERE room_id = $1 AND date >= $2 AND date < $3`,
      [booked.room_id, check_in, check_out]
    );

    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY room_type_availability');
    await client.query('COMMIT');

    res.status(201).json(booked);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Restart/confirm the dev server picked up the change**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/docs.json --max-time 3
```
Expected: `200`.

- [ ] **Step 3: Verify the `room_id` happy path is unaffected**

```bash
cd "c:/Users/robert/source/repos/OTA"
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@bbyc.example.com","password":"Bbyc-dE3OSnze!1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

GUEST_ID=$(curl -s -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"first_name":"RoomId","last_name":"Test","email":"roomid.test@example.com"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"guest_id\":\"$GUEST_ID\",\"room_id\":\"b4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-09-01\",\"check_out\":\"2026-09-03\",\"guests\":2}"
```
Expected: `201`, `"room_id":"b4000000-0000-0000-0000-000000000001"`, `"total_price":"900.00"`.

- [ ] **Step 4: Verify double-booking the same room/dates now fails via the constraint (still `409`, same message)**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"guest_id\":\"$GUEST_ID\",\"room_id\":\"b4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-09-01\",\"check_out\":\"2026-09-03\",\"guests\":2}"
```
Expected: `409 {"error":"Room already booked for this period"}` — same response as before this change, but now produced by catching the database's own rejection rather than a separate manual check.

- [ ] **Step 5: Verify `room_type_id` books an available room and fills up candidates in order**

```bash
for i in 1 2 3 4 5 6; do
  echo "--- attempt $i ---"
  curl -s -w " [%{http_code}]\n" -X POST http://localhost:3000/api/bookings \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d "{\"guest_id\":\"$GUEST_ID\",\"room_type_id\":\"a4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-09-10\",\"check_out\":\"2026-09-12\",\"guests\":2}"
done
```
Expected: 6 successful `201` responses (one per BBYC bungalow, `B1` through `B6`), each with a *different* `room_id` — confirm by eye that all 6 `room_id` values in the output are distinct (they should be `b4000000-0000-0000-0000-000000000001` through `...0006`, in that order, since candidates are ordered by `room_number` and this date range starts empty).

- [ ] **Step 6: Verify exhaustion — the 7th attempt for the same dates fails cleanly**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"guest_id\":\"$GUEST_ID\",\"room_type_id\":\"a4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-09-10\",\"check_out\":\"2026-09-12\",\"guests\":2}"
```
Expected: `409 {"error":"No rooms of this type available for the requested dates"}`.

- [ ] **Step 7: Verify validation — both or neither of `room_id`/`room_type_id`**

```bash
echo "--- both provided ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"guest_id\":\"$GUEST_ID\",\"room_id\":\"b4000000-0000-0000-0000-000000000001\",\"room_type_id\":\"a4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-09-20\",\"check_out\":\"2026-09-21\"}"

echo "--- neither provided ---"
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "{\"guest_id\":\"$GUEST_ID\",\"check_in\":\"2026-09-20\",\"check_out\":\"2026-09-21\"}"
```
Expected: both `400 {"error":"guest_id, check_in, check_out, and exactly one of room_id or room_type_id are required"}`.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/bookings.js
git commit -m "Support booking by room_type_id with constraint-based race safety"
```

---

### Task 3: Document `room_type_id` in Swagger

**Files:**
- Modify: `src/docs/swagger.js` (`/api/bookings` path — `post` block)

**Interfaces:**
- Consumes: nothing from Task 1/2 (documentation only).

- [ ] **Step 1: Add `room_type_id` to the request schema**

Replace:
```js
      post: { tags: ['Bookings'], summary: 'Create booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'room_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } }, property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room not available' } } },
```
with:
```js
      post: { tags: ['Bookings'], summary: 'Create booking', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['guest_id', 'check_in', 'check_out'], properties: { guest_id: { type: 'string', format: 'uuid' }, room_id: { type: 'string', format: 'uuid', description: 'Exactly one of room_id or room_type_id is required.' }, room_type_id: { type: 'string', format: 'uuid', description: 'Alternative to room_id: books the first available room of this type. Exactly one of room_id or room_type_id is required.' }, check_in: { type: 'string', format: 'date' }, check_out: { type: 'string', format: 'date' }, guests: { type: 'integer' }, metadata: { type: 'object', additionalProperties: true, example: { pickup_location: 'InterContinental Le Moana Bora Bora Resort' } }, property_id: { type: 'string', format: 'uuid', description: 'Required only when authenticating with X-Api-Key; ignored (the JWT\'s property is used instead) when authenticating with a Bearer token.' } } } } } }, responses: { 201: { description: 'Booking created with total price' }, 409: { description: 'Room (or room type) not available' } } },
```
(Note `required` dropped `room_id` — it's no longer unconditionally required now that `room_type_id` is a valid alternative; the actual "exactly one" rule is enforced by the API at runtime and documented in both fields' `description`.)

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  const j = JSON.parse(d);
  const props = j.paths['/api/bookings'].post.requestBody.content['application/json'].schema.properties;
  console.log('has room_type_id:', 'room_type_id' in props);
  console.log('required:', j.paths['/api/bookings'].post.requestBody.content['application/json'].schema.required);
});
"
```
Expected: `has room_type_id: true`; `required: [ 'guest_id', 'check_in', 'check_out' ]`.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document room_type_id on POST /api/bookings"
```

---

### Task 4: Migrate otadb, push, and verify live

**Files:** none (migration + deploy + verification only).

**Interfaces:**
- Consumes: `src/db/migrate-2026-07-22-booking-no-overlap.sql` from Task 1, and Task 2/3's commits.

- [ ] **Step 1: Confirm no overlapping non-cancelled bookings exist on `otadb`, then confirm with the user before migrating**

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({
    connectionString: 'postgresql://otadb_user:MRBEK2ocVbd2qFUqLGLcAZjYWoQE7SsE@dpg-d9a98smrnols739u2oc0-a.virginia-postgres.render.com/otadb',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const res = await client.query(\`
    SELECT a.id AS a_id, b.id AS b_id, a.room_id
    FROM booking a
    JOIN booking b ON a.room_id = b.room_id AND a.id < b.id
    WHERE a.status <> 'cancelled' AND b.status <> 'cancelled'
      AND a.check_in < b.check_out AND a.check_out > b.check_in
  \`);
  console.log('overlaps found:', res.rows.length);
  await client.end();
})();
"
```
Expected: `overlaps found: 0` (already confirmed once during design; re-confirm here since live data may have changed since then). If nonzero, STOP — do not proceed; the constraint would fail to apply and the conflicting bookings need resolving first (out of scope for this plan).

Then confirm with the user before running the migration against `otadb`, per this project's established practice for any live-database write.

- [ ] **Step 2: Run the migration against `otadb`**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({
    connectionString: 'postgresql://otadb_user:MRBEK2ocVbd2qFUqLGLcAZjYWoQE7SsE@dpg-d9a98smrnols739u2oc0-a.virginia-postgres.render.com/otadb',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  await client.query(fs.readFileSync('src/db/migrate-2026-07-22-booking-no-overlap.sql', 'utf8'));
  const res = await client.query(\"SELECT conname FROM pg_constraint WHERE conname = 'booking_no_overlap'\");
  console.log(res.rows);
  const count = await client.query('SELECT COUNT(*) FROM booking');
  console.log('booking rows preserved:', count.rows[0].count);
  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `[ { conname: 'booking_no_overlap' } ]`, no errors, and `booking rows preserved:` printing a nonzero count matching whatever `otadb` had before this step (the `ALTER TABLE ... ADD CONSTRAINT` only adds a constraint — it cannot remove rows, but confirming the count is unchanged catches any unrelated surprise).

- [ ] **Step 3: Confirm with the user before pushing, then push**

Per this project's established practice for any push to `origin/main` that triggers a live Render redeploy.

```bash
git push origin main
```

- [ ] **Step 4: Wait for Render to redeploy**

```bash
for i in $(seq 1 20); do
  RESULT=$(curl -s https://ota-u6ii.onrender.com/api/docs.json 2>/dev/null | node -e "
let d='';
process.stdin.on('data', c => d += c).on('end', () => {
  try {
    const j = JSON.parse(d);
    const props = j.paths['/api/bookings'].post.requestBody.content['application/json'].schema.properties;
    console.log('room_type_id' in props ? 'READY' : 'NOT_READY');
  } catch(e) { console.log('NOT_READY'); }
});
" 2>/dev/null)
  echo "attempt $i: $RESULT"
  if [ "$RESULT" = "READY" ]; then break; fi
  sleep 15
done
```
Expected: eventually prints `READY`.

- [ ] **Step 5: Repeat Task 2 Steps 3-6 against the live service**

Same requests as Task 2, but against `https://ota-u6ii.onrender.com`, and using a fresh date range (e.g. `2026-09-25`–`2026-09-27`) to avoid colliding with anything already booked on `otadb` from prior live-verification work this session.

Expected: identical status codes and error messages to Task 2's local runs (happy path `201`, repeat-booking `409` via the constraint, 6 successful room-type bookings filling all bungalows, 7th attempt `409` exhaustion).

- [ ] **Step 6: No further action** — this task is migration + deploy + verification only. If any expected output didn't match, the code and constraint are already live; fix forward with a new commit/migration rather than reverting.
