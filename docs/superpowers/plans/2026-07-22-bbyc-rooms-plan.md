# BBYC Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BBYC (Bora Bora Yacht Club) as a fourth bookable `property`, with one `Bungalow` room type, 6 rooms, and enough availability to book a stay through the live API today — per `docs/superpowers/specs/2026-07-22-bbyc-rooms-design.md`.

**Architecture:** One new additive seed file, `src/db/seed-bbyc-rooms.sql`, inserting a `property`, its bootstrap `api_user`, one `room_type`, 6 `room` rows, and `room_availability` rows for a 90-day forward window. No schema changes, no code changes — pure data, following the same pattern `seed-restaurant-bbyc.sql` already uses for additive rollout against a live database.

**Tech Stack:** Node/Express, `pg` (plain SQL, no query builder/ORM), PostgreSQL.

## Global Constraints

- No migrations tool exists — seed files are plain `.sql`, applied via `psql`/`node` scripts. This file is purely additive (`INSERT` only, no `ALTER TABLE`), so — unlike a schema migration — it's safe to run directly against an already-populated database with no data-loss risk.
- Not safely re-runnable: running it twice creates a duplicate `BBYC` property. Same one-time-script caveat as `seed-restaurant-bbyc.sql`.
- No automated test framework exists in this project (no jest/mocha, no `test` script). Every "verify" step in this plan is a **manual check**: a `curl` command against a running `npm run dev` server, or a `psql`/`node` query — each with the exact expected output.
- Two databases are involved: local Postgres (`hotel_booking` on `localhost:5432`) and the remote Render `otadb` instance backing the live deployed service (`https://ota-u6ii.onrender.com`).
- Confirm with the user before running the seed script against `otadb`, per this project's established practice for any write against the live database — even though this one is additive/non-destructive.
- Today's date for choosing test dates in this plan: **2026-07-22**. The seeded availability window is `2026-07-22`–`2026-10-20`.
- All new ids continue existing series: property `e1000000-...004`, admin `f4000000-...001`, room_type `a4000000-...001`, rooms `b4000000-...001`–`...006`.
- This feature is hotel-rooms-module only — do not touch the existing unscoped `BBYC` restaurant row or the restaurant module.

---

### Task 1: Write `seed-bbyc-rooms.sql`, seed and verify locally

**Files:**
- Create: `src/db/seed-bbyc-rooms.sql`

**Interfaces:**
- Produces: property id `e1000000-0000-0000-0000-000000000004` (BBYC), room_type id `a4000000-0000-0000-0000-000000000001` (Bungalow, max_occupancy 2, base_rate 450.00), room ids `b4000000-0000-0000-0000-000000000001`–`...006` (room_number `B1`–`B6`), admin login `admin@bbyc.example.com` / `changeme123`.
- Consumes: nothing (independent of `seed.sql`'s data — only depends on `schema.sql`).

- [ ] **Step 1: Write the seed file**

Create `src/db/seed-bbyc-rooms.sql`:

```sql
-- Property, bootstrap admin, and bungalow rooms for BBYC (Bora Bora Yacht
-- Club). Run after schema.sql - independent of seed.sql's data, but kept in
-- the same file list for fresh resets. Not safely re-runnable (would create
-- a duplicate BBYC property) - same one-time-script caveat as
-- seed-restaurant-bbyc.sql. See
-- docs/superpowers/specs/2026-07-22-bbyc-rooms-design.md.

INSERT INTO property (id, name, status) VALUES
  ('e1000000-0000-0000-0000-000000000004', 'BBYC', 'active');

-- Bootstrap admin (password: "changeme123", same hash as the other seeded admins)
INSERT INTO api_user (id, property_id, name, email, password_hash, role) VALUES
  ('f4000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000004',
   'BBYC Admin', 'admin@bbyc.example.com',
   '$2b$12$AeG.yVLwhNPTxp2WeowJ8OZ6J9m4Kyn/sasVTECO/nHbxaBXMzycu', 'admin');

-- Room type
INSERT INTO room_type (id, property_id, name, description, max_occupancy, base_rate) VALUES
  ('a4000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000004',
   'Bungalow', 'Waterfront bungalow at the Bora Bora Yacht Club', 2, 450.00);

-- Rooms
INSERT INTO room (id, property_id, room_type_id, room_number, floor, status) VALUES
  ('b4000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B1', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B2', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B3', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000004', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B4', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000005', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B5', NULL, 'active'),
  ('b4000000-0000-0000-0000-000000000006', 'e1000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000001', 'B6', NULL, 'active');

-- Availability: 90 days forward from today (2026-07-22) so BBYC is bookable now
INSERT INTO room_availability (property_id, room_id, date, is_available)
SELECT
  r.property_id,
  r.id,
  generate_series('2026-07-22'::date, '2026-10-20'::date, '1 day'::interval)::date AS date,
  true
FROM room r
WHERE r.property_id = 'e1000000-0000-0000-0000-000000000004'
  AND r.status = 'active'
ON CONFLICT (room_id, date) DO NOTHING;
```

- [ ] **Step 2: Full reset and reseed — local**

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
Expected: `done`, no errors. (`npm run dev` should already be running against this database — it reconnects automatically on the next query, no restart needed since no schema changed.)

- [ ] **Step 3: Verify BBYC property, room type, and rooms via the API**

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@bbyc.example.com","password":"changeme123"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

curl -s "http://localhost:3000/api/room-types" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:3000/api/rooms" -H "Authorization: Bearer $TOKEN"
```
Expected: first response is a JSON array containing one room type named `Bungalow`, `max_occupancy: 2`, `base_rate: "450.00"`. Second response is a JSON array (or `{data: [...]}`, matching whatever shape `/api/rooms` already returns) containing 6 rooms with `room_number` `B1` through `B6`, all `status: "active"`, `floor: null`.

- [ ] **Step 4: Verify availability search finds BBYC**

```bash
curl -s "http://localhost:3000/api/availability/search?check_in=2026-08-01&check_out=2026-08-03&guests=2" -H "Authorization: Bearer $TOKEN"
```
Expected: `200`, response includes an entry for the Bungalow `room_type_id` (`a4000000-0000-0000-0000-000000000001`) with `min_available: 6` and `from_rate: "450.00"` (or equivalent numeric/string form matching the endpoint's existing response shape).

- [ ] **Step 5: Verify a real booking can be created, with metadata**

```bash
curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"guest_id":null,"room_id":"b4000000-0000-0000-0000-000000000001","check_in":"2026-08-01","check_out":"2026-08-03","guests":2,"metadata":{"pickup_location":"Conrad Base"}}'
```
This will 404/400 on `guest_id` since none exists for the BBYC property yet — first create one:

```bash
GUEST_ID=$(curl -s -X POST http://localhost:3000/api/guests -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"first_name":"Test","last_name":"Guest","email":"test.guest@example.com"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"guest_id\":\"$GUEST_ID\",\"room_id\":\"b4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-08-01\",\"check_out\":\"2026-08-03\",\"guests\":2,\"metadata\":{\"pickup_location\":\"Conrad Base\"}}"
```
Expected: `201`, response includes `"total_price":"900.00"` (2 nights × $450.00) and `"metadata":{"pickup_location":"Conrad Base"}`.

- [ ] **Step 6: Commit**

```bash
git add src/db/seed-bbyc-rooms.sql
git commit -m "Add BBYC property with bungalow rooms and availability"
```

---

### Task 2: Roll out to otadb and verify live

**Files:** none (data rollout only — no code changes).

**Interfaces:**
- Consumes: `src/db/seed-bbyc-rooms.sql` from Task 1.

- [ ] **Step 1: Confirm with the user before running against otadb**

Per this project's established practice for any write against the live database, confirm with the user before proceeding — even though this script is purely additive and does not touch or delete any existing rows.

- [ ] **Step 2: Run the seed file against otadb**

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
  await client.query(fs.readFileSync('src/db/seed-bbyc-rooms.sql', 'utf8'));
  const rooms = await client.query(\"SELECT room_number, status FROM room WHERE property_id = 'e1000000-0000-0000-0000-000000000004' ORDER BY room_number\");
  console.log(rooms.rows);
  await client.end();
})().catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: prints 6 rows, `room_number` `B1`–`B6`, all `status: 'active'`, no errors.

- [ ] **Step 3: Verify live via the deployed API**

```bash
TOKEN=$(curl -s -X POST https://ota-u6ii.onrender.com/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@bbyc.example.com","password":"changeme123"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

curl -s "https://ota-u6ii.onrender.com/api/rooms" -H "Authorization: Bearer $TOKEN"
curl -s "https://ota-u6ii.onrender.com/api/availability/search?check_in=2026-08-01&check_out=2026-08-03&guests=2" -H "Authorization: Bearer $TOKEN"
```
Expected: rooms response includes the 6 `B1`–`B6` rooms; availability search includes the Bungalow room type with `min_available: 6`.

- [ ] **Step 4: Verify a live booking can be created, with metadata**

```bash
GUEST_ID=$(curl -s -X POST https://ota-u6ii.onrender.com/api/guests -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"first_name":"Live Test","last_name":"Guest","email":"live.test.guest@example.com"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")

curl -s -w "\nHTTP_STATUS:%{http_code}\n" -X POST https://ota-u6ii.onrender.com/api/bookings \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"guest_id\":\"$GUEST_ID\",\"room_id\":\"b4000000-0000-0000-0000-000000000001\",\"check_in\":\"2026-08-05\",\"check_out\":\"2026-08-07\",\"guests\":2,\"metadata\":{\"pickup_location\":\"Conrad Base\"}}"
```
Expected: `201`, response includes `"total_price":"900.00"` and `"metadata":{"pickup_location":"Conrad Base"}`. (Uses `2026-08-05`–`2026-08-07` rather than Task 1's `2026-08-01`–`2026-08-03` since that room/date pair may already be booked from local testing against a different database — this is a separate `otadb` instance, but distinct dates avoid any ambiguity.)

- [ ] **Step 5: Confirm with the user before pushing**

The seed file itself doesn't need to be deployed for the data to be live (Task 2 Step 2 already wrote directly to `otadb`), but push the commit from Task 1 to keep `origin/main` in sync with what's now in the database. Confirm with the user before pushing, per this project's established practice for any push to `origin/main`.

```bash
git push origin main
```

- [ ] **Step 6: No further action** — this task is rollout + verification only. If any expected output above didn't match, fix `seed-bbyc-rooms.sql` (or the affected rows directly, since Task 1's local reset already covers a from-scratch fix) and re-run Task 2 from Step 2.
