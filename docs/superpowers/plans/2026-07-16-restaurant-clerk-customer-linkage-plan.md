# Restaurant Reservation Clerk Customer Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a restaurant reservation be tagged with a `clerk_user_id`, and let the API-key-holding caller (the restaurant website's backend, which owns its own Clerk session handling) list a specific customer's own reservations — per `docs/superpowers/specs/2026-07-16-restaurant-clerk-customer-linkage-design.md`.

**Architecture:** One nullable `clerk_user_id` column on `restaurant_reservation`, set optionally at creation and usable as a new list filter. No Clerk SDK, no ownership enforcement, no link to the property-scoped `guest` table — self-contained to the restaurant module.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- No migrations tool exists — `schema.sql` is edited in place and applied to a **freshly reset** dev database (drop/recreate). Do not write ALTER TABLE migrations as a separate file; the reset+reapply cycle is how this project rolls out schema changes.
- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, or a `psql`/`node` query — each with the exact expected output.
- Two databases must be reset when rolling this out: the local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance, which is what the live deployed service (`https://ota-u6ii.onrender.com`) actually uses.
- `clerk_user_id` is a plain opaque string — no format validation, no FK, no required-ness. Do not add Clerk SDK integration or any session/token verification as part of this work.
- No ownership enforcement on `PUT /reservations/:id` — the API-key holder is a fully trusted caller, matching every other write in this module.

---

### Task 1: Add `clerk_user_id` column to `restaurant_reservation`

**Files:**
- Modify: `src/db/schema.sql:175-192` (`restaurant_reservation` table + indexes)

**Interfaces:**
- Produces: `restaurant_reservation(clerk_user_id)` — Task 2's controller code reads/writes this column by name.

- [ ] **Step 1: Add the column**

In `src/db/schema.sql`, replace:
```sql
CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id         UUID         NOT NULL REFERENCES restaurant_table(id),
  reservation_date DATE         NOT NULL,
  start_time       TIME         NOT NULL,
  end_time         TIME         NOT NULL,
  guest_id         UUID         REFERENCES guest(id),
  contact_name     VARCHAR(100) NOT NULL,
  contact_email    VARCHAR(255),
  contact_phone    VARCHAR(30),
  party_size       INT          NOT NULL,
  status           VARCHAR(20)  DEFAULT 'confirmed',
  notes            TEXT,
  created_at       TIMESTAMPTZ  DEFAULT now()
);
```
with:
```sql
CREATE TABLE IF NOT EXISTS restaurant_reservation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id         UUID         NOT NULL REFERENCES restaurant_table(id),
  reservation_date DATE         NOT NULL,
  start_time       TIME         NOT NULL,
  end_time         TIME         NOT NULL,
  guest_id         UUID         REFERENCES guest(id),
  clerk_user_id    VARCHAR(100),
  contact_name     VARCHAR(100) NOT NULL,
  contact_email    VARCHAR(255),
  contact_phone    VARCHAR(30),
  party_size       INT          NOT NULL,
  status           VARCHAR(20)  DEFAULT 'confirmed',
  notes            TEXT,
  created_at       TIMESTAMPTZ  DEFAULT now()
);
```

- [ ] **Step 2: Add the index**

Replace:
```sql
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant    ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time ON restaurant_reservation(table_id, reservation_date, start_time);
```
with:
```sql
CREATE INDEX IF NOT EXISTS idx_restaurant_table_restaurant    ON restaurant_table(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_table_date_time ON restaurant_reservation(table_id, reservation_date, start_time);
CREATE INDEX IF NOT EXISTS idx_restaurant_res_clerk_user      ON restaurant_reservation(clerk_user_id);
```

- [ ] **Step 3: Reset local dev DB and verify**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `done`, no errors.

```bash
node -e "
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  const r = await client.query(\"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'restaurant_reservation' AND column_name = 'clerk_user_id'\");
  console.log(r.rows);
  await client.end();
})();
"
```
Expected: `[ { column_name: 'clerk_user_id', data_type: 'character varying' } ]`.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.sql
git commit -m "Add clerk_user_id column to restaurant_reservation"
```

---

### Task 2: Accept and filter by `clerk_user_id` in the reservation endpoints

**Files:**
- Modify: `src/controllers/restaurant.js:186-297` (`listReservations`, `createReservation`)

**Interfaces:**
- Consumes: `restaurant_reservation(clerk_user_id)` from Task 1.
- Produces: no change to exported function names.

- [ ] **Step 1: Accept `clerk_user_id` on create**

Replace:
```js
async function createReservation(req, res, next) {
  const { restaurant_id } = req.params;
  const { reservation_date, start_time, location, guest_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;
```
with:
```js
async function createReservation(req, res, next) {
  const { restaurant_id } = req.params;
  const { reservation_date, start_time, location, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes } = req.body;
```

Replace the insert:
```js
    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, reservation_date, start_time, end_time, guest_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
    );
```
with:
```js
    const { rows } = await client.query(
      `INSERT INTO restaurant_reservation
         (table_id, reservation_date, start_time, end_time, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, party_size, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [assignedTableId, reservation_date, start_time, end_time, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, party_size, notes ?? null]
    );
```

- [ ] **Step 2: Add `clerk_user_id` as a list filter**

Replace:
```js
async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rt.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    query += ' ORDER BY rr.reservation_date, rr.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}
```
with:
```js
async function listReservations(req, res, next) {
  try {
    const { restaurant_id } = req.params;
    const { date, status, guest_id, clerk_user_id } = req.query;
    let query = `
      SELECT rr.*, rt.table_number, rt.seats, rt.location
      FROM restaurant_reservation rr
      JOIN restaurant_table rt ON rt.id = rr.table_id
      WHERE rt.restaurant_id = $1
    `;
    const params = [restaurant_id];
    if (date) { params.push(date); query += ` AND rr.reservation_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND rr.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND rr.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND rr.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY rr.reservation_date, rr.start_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}
```

- [ ] **Step 3: Verify** (server running against the reset local DB from Task 1; `$RID` = Bonito's restaurant id, `$API_KEY` from `.env`)

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:00","party_size":2,"contact_name":"Alice","clerk_user_id":"user_abc"}'

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-20","start_time":"19:15","party_size":2,"contact_name":"Bob","clerk_user_id":"user_xyz"}'
```
Expected: both `201`, each response includes `"clerk_user_id":"user_abc"` and `"clerk_user_id":"user_xyz"` respectively.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/reservations?clerk_user_id=user_abc" -H "X-Api-Key: $API_KEY"
```
Expected: `200` with an array containing exactly Alice's reservation, not Bob's.

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/reservations" -H "X-Api-Key: $API_KEY"
```
Expected: `200` with both reservations (no filter applied, existing behavior unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/controllers/restaurant.js
git commit -m "Accept and filter reservations by clerk_user_id"
```

---

### Task 3: Update Swagger docs

**Files:**
- Modify: `src/docs/swagger.js:283-285`

**Interfaces:**
- Consumes: nothing from prior tasks (documentation only).
- Produces: docs matching Task 2's request/query shape.

- [ ] **Step 1: Add `clerk_user_id` to the list-reservations query params and create-reservation request schema**

Replace:
```js
    '/api/restaurant/{restaurant_id}/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Array of reservations' } } },
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
    },
```
with:
```js
    '/api/restaurant/{restaurant_id}/reservations': {
      get: { tags: ['Restaurant'], summary: 'List reservations', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'guest_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'clerk_user_id', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Array of reservations' } } },
      post: { tags: ['Restaurant'], summary: 'Create reservation (table auto-assigned)', parameters: [{ name: 'restaurant_id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reservation_date', 'start_time', 'contact_name', 'party_size'], properties: { reservation_date: { type: 'string', format: 'date' }, start_time: { type: 'string', example: '19:00' }, location: { type: 'string' }, guest_id: { type: 'string', format: 'uuid' }, clerk_user_id: { type: 'string' }, contact_name: { type: 'string' }, contact_email: { type: 'string' }, contact_phone: { type: 'string' }, party_size: { type: 'integer' }, notes: { type: 'string' } } } } } }, responses: { 201: { description: 'Reservation created' }, 409: { description: 'No tables available for this time' } } },
    },
```

- [ ] **Step 2: Verify**

```bash
curl -s http://localhost:3000/api/docs.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const p=j.paths['/api/restaurant/{restaurant_id}/reservations'];console.log(p.get.parameters.map(x=>x.name));console.log(Object.keys(p.post.requestBody.content['application/json'].schema.properties));})"
```
Expected: the first line's array includes `clerk_user_id`; the second line's array includes `clerk_user_id`.

- [ ] **Step 3: Commit**

```bash
git add src/docs/swagger.js
git commit -m "Document clerk_user_id in restaurant reservation Swagger docs"
```

---

### Task 4: Full reset, reseed, and live verification (local + remote)

**Files:** none (verification only — no code changes).

**Interfaces:** none.

- [ ] **Step 1: Full reset and reseed — local**

```bash
node -e "
const fs = require('fs');
const { Client } = require('pg');
(async () => {
  const client = new Client({ connectionString: 'postgresql://postgres:W1nd1es1@localhost:5432/hotel_booking', ssl: false });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
npm run dev
```
Expected: `done`, then `Server running on port 3000` with no errors.

- [ ] **Step 2: End-to-end check against the fresh local DB**

```bash
RID=$(curl -s http://localhost:3000/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(r=>r.name==='Bonito').id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -X POST "http://localhost:3000/api/restaurant/$RID/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-22","start_time":"19:00","party_size":2,"contact_name":"Carol","clerk_user_id":"user_carol"}'
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "http://localhost:3000/api/restaurant/$RID/reservations?clerk_user_id=user_carol" -H "X-Api-Key: $API_KEY"
```
Expected: the POST returns `201`; the GET returns `200` with exactly Carol's reservation.

- [ ] **Step 3: Repeat the reset against the remote `otadb` instance**

Confirm with the user before running this against the live database, per this project's established practice this session for any schema reset against `otadb`.

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
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const f of ['src/db/schema.sql', 'src/db/seed.sql', 'src/db/seed-restaurant-bonito.sql', 'src/db/seed-extras.sql']) {
    await client.query(fs.readFileSync(f, 'utf8'));
  }
  await client.end();
  console.log('done');
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `done`, no errors.

- [ ] **Step 4: Push to origin and confirm the live service picks up the change**

Confirm with the user before pushing to `origin/main`, per this project's established practice this session for any push that triggers a live Render redeploy.

```bash
git push origin main
```
Wait for Render to finish redeploying (poll `https://ota-u6ii.onrender.com/api/docs.json` until its `/api/restaurant/{restaurant_id}/reservations` `get.parameters` includes `clerk_user_id`), then:

```bash
RID_LIVE=$(curl -s https://ota-u6ii.onrender.com/api/restaurant | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].id))")
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2)
curl -s -X POST "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/reservations" \
  -H "Content-Type: application/json" -H "X-Api-Key: $API_KEY" \
  -d '{"reservation_date":"2026-07-22","start_time":"19:00","party_size":2,"contact_name":"Dave","clerk_user_id":"user_dave"}'
curl -s -w "\nHTTP_STATUS:%{http_code}\n" "https://ota-u6ii.onrender.com/api/restaurant/$RID_LIVE/reservations?clerk_user_id=user_dave" -H "X-Api-Key: $API_KEY"
```
Expected: the POST returns `201`; the GET returns `200` with exactly Dave's reservation.

- [ ] **Step 5: No commit needed** — this task is verification-only. If any step's actual output didn't match, go back to the relevant earlier task and fix it before considering this feature done.
