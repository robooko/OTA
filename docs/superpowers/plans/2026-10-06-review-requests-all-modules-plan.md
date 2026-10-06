# Review Requests for Every Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One post-visit review request per guest per visit, drawn from every booking module, replacing the spa-only sender.

**Architecture:** A `review_candidate` SQL view normalises finished bookings from every eligible module. A single `INSERT … SELECT … RETURNING` claim against it writes `review_request` rows, one per guest whose visit is over. The existing 15-minute job sends from those rows, retries failures, and uses a generalised `sendReviewRequest`. Opt-out moves to a property-wide route keyed by the request ID.

**Tech Stack:** Node / Express / `pg` / Resend, with no test framework. Checks are `node` scripts that use `assert` against the local DB inside a rolled-back transaction.

**Spec:** `docs/superpowers/specs/2026-10-06-review-requests-all-modules-design.md`

## Global Constraints

- Modules and their keys (`property.enabled_modules`): `rooms`, `restaurant_reservations`, `restaurants`, `spa`, `tours`, `golf`, `equipment`. Beach club, shop orders and event enquiries are excluded.
- Every date or time column is local to `property.timezone`.
- Ends: rooms at `check_out` 11:00; reservations and spa at `date + end_time`; restaurant orders at `paid_at`; tours at `slot_date + slot_time + tour.duration_mins`; golf at `tee_date + tee_time + 4h`; equipment at `hire_date + start_time + duration` hours (start of day + 24 h when there's no start time).
- Excluded statuses: `cancelled` and `no_show`. Restaurant orders count only when `payment_status = 'paid'`.
- A guest (property + lowercased email) is claimed when: a candidate ended between 2 days ago and `now − delay`; none ends after now and within 14 days; no request was made within the cooldown; and they haven't opted out.
- `MAX_ATTEMPTS = 3`. Sweep every 15 minutes, sequential sends.
- Email subject: "How was your visit to {property}?"
- The migration goes to the **local DB first** (`DATABASE_URL_LIVE= node scripts/run-migration.js …`). The live DB and `git push` (which deploys to Render) need the user's OK.

## Review Focus

1. **Guest email in mixed case or with spaces** (`Jo@X.com ` on one booking, `jo@x.com` on another). Expected: treated as one guest, so one request and one cooldown. Pinned in Task 2, check "email normalised".
2. **A property in a non-UK timezone.** Expected: "ended" is judged in local time, not UTC. Pinned in Task 2, check "timezone".
3. **Spa guests asked under the old system just before deploy.** Expected: the cooldown still applies (backfill). Pinned in Task 1, backfill check.
4. **Resend fails.** Expected: retried on the next sweep, at most 3 attempts in total, never two emails for one request. Pinned in Task 2, check "retry".
5. **An old spa opt-out link** in emails already sent. Expected: it still opts the guest out. Pinned in Task 3.

---

### Task 1: Migration — table, view, spa backfill

**Files:**
- Create: `src/db/migrate-2026-10-06-review-requests-all-modules.sql`
- Modify: `src/db/schema.sql` (append the same objects after `review_request_opt_out`)

**Interfaces:**
- Produces: table `review_request(id, property_id, email, contact_name, module, booking_id, sent_at, attempts, resend_email_id, created_at)`, unique `(module, booking_id)`. View `review_candidate(property_id, email, contact_name, module, booking_id, ended_at)`.

- [ ] **Step 1: Write the migration**

```sql
-- Review requests for every module, one per visit -- see
-- docs/superpowers/specs/2026-10-06-review-requests-all-modules-design.md.
--
-- review_request: one row per request sent (or being retried), whatever
-- module the triggering booking came from. contact_name is copied at
-- claim time so a retry needs nothing else.
-- review_candidate: every eligible module's bookings in one shape, with
-- ended_at as a timestamptz in the property's own timezone. Includes
-- bookings that haven't ended yet -- the claim needs to see a visit
-- that's still in progress.
-- Backfill: spa requests already sent under the old per-appointment
-- columns, so the cooldown keeps counting them. Those columns stay as
-- history; nothing writes them after this.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).

CREATE TABLE IF NOT EXISTS review_request (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID NOT NULL REFERENCES property(id),
  email            VARCHAR(255) NOT NULL,
  contact_name     VARCHAR(100),
  module           VARCHAR(30)  NOT NULL,
  booking_id       UUID NOT NULL,
  sent_at          TIMESTAMPTZ,
  attempts         SMALLINT NOT NULL DEFAULT 1,
  resend_email_id  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module, booking_id)
);
CREATE INDEX IF NOT EXISTS idx_review_request_guest ON review_request (property_id, email, created_at);
CREATE INDEX IF NOT EXISTS idx_review_request_retry ON review_request (attempts) WHERE sent_at IS NULL;

CREATE OR REPLACE VIEW review_candidate AS
SELECT * FROM (
  -- rooms: departure counted as 11:00 local on the check-out date
  SELECT b.property_id, lower(trim(g.email)) AS email, g.first_name::varchar(100) AS contact_name,
         'rooms'::varchar(30) AS module, b.id AS booking_id,
         (b.check_out + time '11:00') AT TIME ZONE p.timezone AS ended_at
  FROM booking b JOIN guest g ON g.id = b.guest_id JOIN property p ON p.id = b.property_id
  WHERE coalesce(b.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  SELECT r.property_id, lower(trim(r.contact_email)), r.contact_name, 'restaurant_reservations', r.id,
         (r.reservation_date + r.end_time) AT TIME ZONE p.timezone
  FROM restaurant_reservation r JOIN property p ON p.id = r.property_id
  WHERE coalesce(r.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  SELECT o.property_id, lower(trim(o.contact_email)), o.contact_name, 'restaurants', o.id, o.paid_at
  FROM restaurant_order o
  WHERE o.payment_status = 'paid' AND o.paid_at IS NOT NULL
  UNION ALL
  SELECT s.property_id, lower(trim(s.contact_email)), s.contact_name, 'spa', s.id,
         (s.appointment_date + s.end_time) AT TIME ZONE p.timezone
  FROM spa_appointment s JOIN property p ON p.id = s.property_id
  WHERE coalesce(s.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  -- tours: the tour's own duration after the slot starts
  SELECT tb.property_id, lower(trim(coalesce(tb.contact_email, g.email))), tb.contact_name, 'tours', tb.id,
         (ts.slot_date + ts.slot_time + make_interval(mins => t.duration_mins)) AT TIME ZONE p.timezone
  FROM tour_booking tb
  JOIN tour_slot ts ON ts.id = tb.slot_id JOIN tour t ON t.id = ts.tour_id
  JOIN property p ON p.id = tb.property_id LEFT JOIN guest g ON g.id = tb.guest_id
  WHERE coalesce(tb.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  -- golf: a round counted as 4 hours from the tee time
  SELECT gb.property_id, lower(trim(coalesce(gb.contact_email, g.email))), gb.contact_name, 'golf', gb.id,
         (tt.tee_date + tt.tee_time + interval '4 hours') AT TIME ZONE p.timezone
  FROM golf_booking gb
  JOIN tee_time tt ON tt.id = gb.tee_time_id
  JOIN property p ON p.id = gb.property_id LEFT JOIN guest g ON g.id = gb.guest_id
  WHERE coalesce(gb.status, 'confirmed') NOT IN ('cancelled', 'no_show')
  UNION ALL
  -- equipment: start + duration hours; a hire with no start time ends at the end of its day
  SELECT e.property_id, lower(trim(coalesce(e.contact_email, g.email))), e.contact_name, 'equipment', e.id,
         (CASE WHEN e.start_time IS NULL THEN e.hire_date + time '00:00' + interval '24 hours'
               ELSE e.hire_date + e.start_time + make_interval(secs => coalesce(e.duration, 1) * 3600) END) AT TIME ZONE p.timezone
  FROM equipment_hire e
  JOIN property p ON p.id = e.property_id LEFT JOIN guest g ON g.id = e.guest_id
  WHERE coalesce(e.status, 'confirmed') NOT IN ('cancelled', 'no_show')
) u
WHERE email IS NOT NULL AND email <> '';

INSERT INTO review_request (property_id, email, contact_name, module, booking_id, sent_at, attempts, resend_email_id, created_at)
SELECT sa.property_id, lower(trim(sa.contact_email)), sa.contact_name, 'spa', sa.id,
       sa.review_request_sent_at, greatest(sa.review_request_attempts, 1), sa.review_request_resend_email_id, sa.review_request_sent_at
FROM spa_appointment sa
WHERE sa.review_request_sent_at IS NOT NULL AND sa.contact_email IS NOT NULL
ON CONFLICT (module, booking_id) DO NOTHING;
```

- [ ] **Step 2: Apply to the local DB, twice**

Run: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-10-06-review-requests-all-modules.sql` (twice)
Expected: both runs succeed. The second is a no-op: no duplicate-object errors, and the backfill inserts nothing new.

- [ ] **Step 3: Check the view and the backfill**

Run:
```bash
node -r dotenv/config -e "
const pool=require('./src/db');(async()=>{
const v=await pool.query('SELECT module, count(*)::int n, min(ended_at) mn, max(ended_at) mx FROM review_candidate GROUP BY module ORDER BY module');console.table(v.rows);
const [a,b]=await Promise.all([pool.query(\"SELECT count(*)::int n FROM spa_appointment WHERE review_request_sent_at IS NOT NULL AND contact_email IS NOT NULL\"),pool.query(\"SELECT count(*)::int n FROM review_request WHERE module='spa'\")]);
console.log('spa sent', a.rows[0].n, 'backfilled', b.rows[0].n);
const bad=await pool.query('SELECT count(*)::int n FROM review_candidate WHERE email <> lower(trim(email)) OR ended_at IS NULL');console.log('bad rows', bad.rows[0].n);
await pool.end();})()"
```
Expected: one row per module that has local data, with plausible date ranges; `spa sent` equals `backfilled`; `bad rows 0`.

- [ ] **Step 4: Mirror in `schema.sql`.** Append the `CREATE TABLE`, both indexes and the `CREATE OR REPLACE VIEW` (not the backfill) after the `review_request_opt_out` block, under a comment pointing at the migration.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate-2026-10-06-review-requests-all-modules.sql src/db/schema.sql
git commit -m "Review requests: review_request table, review_candidate view, spa backfill

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The per-visit claim and sender

**Files:**
- Modify: `src/lib/reviewRequester.js` (rewrite)
- Modify: `src/lib/resend.js` (`sendReviewRequest`)
- Create: `scripts/check-review-requests.js`

**Interfaces:**
- Consumes: `review_request`, `review_candidate` (Task 1).
- Produces: `claimDue(db, at) -> Promise<Array<{ id, property_id, email, contact_name, module, booking_id }>>`, `claimRetries(db, at) -> same shape`, `sweep(db?, at?) -> Promise<number>`, `startReviewRequestJob()` (unchanged export). `sendReviewRequest({ to, name, propertyName, branding, reviewUrl, optOutUrl }) -> Promise<string>`.

- [ ] **Step 1: Write the failing check `scripts/check-review-requests.js`**

```js
// Checks the per-visit review-request claim against the local DB. Every
// fixture lives inside one transaction that is rolled back, so nothing
// persists. Never point this at the live DB.
//   node -r dotenv/config scripts/check-review-requests.js
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { claimDue, claimRetries } = require('../src/lib/reviewRequester');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

const T = (s) => new Date(s); // all fixture instants in UTC; property is Europe/London (BST in July)

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const prop = await one(`INSERT INTO property (name, timezone, review_request_enabled, review_url, review_request_delay_mins, review_request_cooldown_days, enabled_modules)
      VALUES ('Review Check Hotel', 'Europe/London', true, 'https://g.page/r/test/review', 0, 90, NULL) RETURNING id`);
    const P = prop.id;
    const rt = await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P]);
    const room = await one(`INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, 'RC1') RETURNING id`, [P, rt.id]);
    const restaurant = await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Grill', 90) RETURNING id`, [P]);
    const table = await one(`INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats) VALUES ($1, $2, 'T1', 4) RETURNING id`, [P, restaurant.id]);
    const tour = await one(`INSERT INTO tour (property_id, name, duration_mins, max_group_size, price) VALUES ($1, 'Boat', 120, 10, 50) RETURNING id`, [P]);

    const guest = (email) => one(`INSERT INTO guest (property_id, first_name, last_name, email) VALUES ($1, 'Jo', 'Guest', $2) RETURNING id`, [P, email]);
    const stay = (guestId, cin, cout, status = 'confirmed') => one(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, total_price, status) VALUES ($1, $2, $3, $4, $5, 300, $6) RETURNING id`,
      [P, guestId, room.id, cin, cout, status]);
    const dinner = (email, date, start, end, status = 'confirmed') => one(
      `INSERT INTO restaurant_reservation (property_id, table_id, reservation_date, start_time, end_time, contact_name, contact_email, party_size, status)
       VALUES ($1, $2, $3, $4, $5, 'Jo', $6, 2, $7) RETURNING id`, [P, table.id, date, start, end, email, status]);
    const tourBooking = async (email, date, time) => {
      const slot = await one(`INSERT INTO tour_slot (property_id, tour_id, slot_date, slot_time) VALUES ($1, $2, $3, $4) RETURNING id`, [P, tour.id, date, time]);
      return one(`INSERT INTO tour_booking (property_id, slot_id, contact_name, contact_email, group_size, total_price) VALUES ($1, $2, 'Sam', $3, 2, 100) RETURNING id`, [P, slot.id, email]);
    };
    const mine = (rows) => rows.filter((r) => r.property_id === P);

    // Jo: 3-night stay 10-13 July, dinners on the 10th and 11th.
    const jo = await guest('jo@example.com');
    const joStay = await stay(jo.id, '2026-07-10', '2026-07-13');
    await dinner('Jo@Example.com ', '2026-07-10', '19:00', '21:00');
    await dinner('jo@example.com', '2026-07-11', '19:00', '21:00');

    await check('mid-stay: nothing (check-out still to come)', async () => {
      assert.deepEqual(mine(await claimDue(db, T('2026-07-11T21:30:00Z'))), []);
    });

    await check('after check-out: one request, triggered by the stay', async () => {
      const rows = mine(await claimDue(db, T('2026-07-13T12:00:00Z'))); // 13:00 BST, check-out 11:00 BST
      assert.equal(rows.length, 1);
      assert.equal(rows[0].email, 'jo@example.com');
      assert.equal(rows[0].module, 'rooms');
      assert.equal(rows[0].booking_id, joStay.id);
      assert.equal(rows[0].contact_name, 'Jo');
    });

    await check('email normalised: the mixed-case dinner did not make a second guest', async () => {
      const { rows } = await db.query('SELECT count(*)::int n FROM review_request WHERE property_id = $1', [P]);
      assert.equal(rows[0].n, 1);
    });

    await check('second sweep: nothing (cooldown)', async () => {
      assert.deepEqual(mine(await claimDue(db, T('2026-07-13T12:15:00Z'))), []);
    });

    await check('non-staying guest: asked after their last booking', async () => {
      await tourBooking('sam@example.com', '2026-07-20', '10:00'); // ends 12:00 BST = 11:00Z
      assert.deepEqual(mine(await claimDue(db, T('2026-07-20T10:30:00Z'))), [], 'tour not over yet');
      const rows = mine(await claimDue(db, T('2026-07-20T11:05:00Z')));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].module, 'tours');
    });

    await check('timezone: London 21:00 is 20:00Z in July', async () => {
      await dinner('tz@example.com', '2026-07-22', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-22T19:55:00Z'))), [], '20:55 BST, dinner not over');
      assert.equal(mine(await claimDue(db, T('2026-07-22T20:05:00Z'))).length, 1);
    });

    await check('cancelled booking: nothing', async () => {
      await dinner('cancel@example.com', '2026-07-23', '19:00', '21:00', 'cancelled');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-23T22:00:00Z'))), []);
    });

    await check('opted out: nothing', async () => {
      await db.query(`INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, 'out@example.com')`, [P]);
      await dinner('out@example.com', '2026-07-24', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-24T22:00:00Z'))), []);
    });

    await check('2-day floor: an older booking is never backfilled', async () => {
      await dinner('old@example.com', '2026-07-01', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-24T22:00:00Z'))), []);
    });

    await check('module switched off: ignored', async () => {
      await db.query(`UPDATE property SET enabled_modules = '["rooms"]'::jsonb WHERE id = $1`, [P]);
      await dinner('off@example.com', '2026-07-25', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-25T22:00:00Z'))), []);
      await db.query(`UPDATE property SET enabled_modules = NULL WHERE id = $1`, [P]);
    });

    await check('delay respected', async () => {
      await db.query(`UPDATE property SET review_request_delay_mins = 120 WHERE id = $1`, [P]);
      await dinner('delay@example.com', '2026-07-26', '19:00', '21:00'); // ends 20:00Z
      assert.deepEqual(mine(await claimDue(db, T('2026-07-26T21:00:00Z'))), [], 'only 60 min after');
      assert.equal(mine(await claimDue(db, T('2026-07-26T22:01:00Z'))).length, 1);
      await db.query(`UPDATE property SET review_request_delay_mins = 0 WHERE id = $1`, [P]);
    });

    await check('retry: a released request is reclaimed until 3 attempts', async () => {
      await dinner('retry@example.com', '2026-07-27', '19:00', '21:00');
      const [r] = mine(await claimDue(db, T('2026-07-27T21:00:00Z')));
      assert.ok(r);
      for (const attempt of [2, 3]) {
        await db.query('UPDATE review_request SET sent_at = NULL WHERE id = $1', [r.id]); // a failed send
        const again = mine(await claimRetries(db, T('2026-07-27T21:15:00Z')));
        assert.deepEqual(again.map((x) => x.id), [r.id], `attempt ${attempt}`);
      }
      await db.query('UPDATE review_request SET sent_at = NULL WHERE id = $1', [r.id]);
      assert.deepEqual(mine(await claimRetries(db, T('2026-07-27T21:30:00Z'))), [], 'gives up after 3');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-27T21:30:00Z'))), [], 'and is not claimed afresh');
    });
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run, confirm it fails**

Run: `node -r dotenv/config scripts/check-review-requests.js`
Expected: `TypeError: claimDue is not a function` on the first check (the module exports only `sweep`/`startReviewRequestJob`). If instead a fixture `INSERT` fails on a NOT NULL column the plan missed, add that column to the fixture: that's a test-data fix, recorded as a ruling.

- [ ] **Step 3: Rewrite `src/lib/reviewRequester.js`**

```js
const pool = require('../db');
const { sendReviewRequest } = require('./resend');
const { resolveEmailBranding } = require('../controllers/spa');

// Same public host used elsewhere for a link that has to work outside a
// request (src/controllers/property.js's VERCEL_CALLBACK_URL).
const OTA_API_BASE_URL = 'https://ota-u6ii.onrender.com';

const MAX_ATTEMPTS = 3;

// One request per guest per visit, across every module in review_candidate
// (see docs/superpowers/specs/2026-10-06-review-requests-all-modules-design.md).
// A guest (property + lowercased email) is due when a booking of theirs
// ended at least delay ago (but within 2 days -- switching reviews on never
// backfills history), nothing of theirs at the property is still to come
// in the next 14 days (they're mid-stay or back soon), nobody asked them
// there within the cooldown, and they haven't opted out. The trigger is
// their most recently ended booking.
//
// The INSERT is the claim: UNIQUE (module, booking_id) + ON CONFLICT means
// two overlapping sweeps can never send for the same booking. $2 is "now",
// injectable so scripts/check-review-requests.js can move the clock.
const CLAIM_SQL = `
  WITH due AS (
    SELECT DISTINCT ON (c.property_id, c.email)
           c.property_id, c.email, c.contact_name, c.module, c.booking_id
    FROM review_candidate c
    JOIN property p ON p.id = c.property_id
    WHERE p.review_request_enabled
      AND p.review_url IS NOT NULL
      AND (p.enabled_modules IS NULL OR p.enabled_modules ? c.module)
      AND c.ended_at <= $1::timestamptz - make_interval(mins => p.review_request_delay_mins)
      AND c.ended_at >= $1::timestamptz - interval '2 days'
      AND NOT EXISTS (
        SELECT 1 FROM review_candidate f
        WHERE f.property_id = c.property_id AND f.email = c.email
          AND f.ended_at > $1::timestamptz AND f.ended_at <= $1::timestamptz + interval '14 days'
          AND (p.enabled_modules IS NULL OR p.enabled_modules ? f.module)
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_request r
        WHERE r.property_id = c.property_id AND r.email = c.email
          AND r.created_at >= $1::timestamptz - make_interval(days => p.review_request_cooldown_days)
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_request_opt_out o
        WHERE o.property_id = c.property_id AND o.email = c.email
      )
    ORDER BY c.property_id, c.email, c.ended_at DESC
  )
  INSERT INTO review_request (property_id, email, contact_name, module, booking_id, sent_at, created_at)
  SELECT property_id, email, contact_name, module, booking_id, $1::timestamptz, $1::timestamptz FROM due
  ON CONFLICT (module, booking_id) DO NOTHING
  RETURNING id, property_id, email, contact_name, module, booking_id;
`;

// A failed send leaves sent_at NULL; the next sweep reclaims it (setting
// sent_at in the same UPDATE, so it can't be claimed twice) until
// MAX_ATTEMPTS. attempts starts at 1 on the original claim.
const RETRY_SQL = `
  UPDATE review_request rr
  SET sent_at = $1::timestamptz, attempts = rr.attempts + 1
  FROM property p
  WHERE p.id = rr.property_id AND p.review_request_enabled AND p.review_url IS NOT NULL
    AND rr.sent_at IS NULL AND rr.attempts < $2
    AND NOT EXISTS (SELECT 1 FROM review_request_opt_out o WHERE o.property_id = rr.property_id AND o.email = rr.email)
  RETURNING rr.id, rr.property_id, rr.email, rr.contact_name, rr.module, rr.booking_id;
`;

async function claimDue(db = pool, at = new Date()) {
  return (await db.query(CLAIM_SQL, [at])).rows;
}

async function claimRetries(db = pool, at = new Date()) {
  return (await db.query(RETRY_SQL, [at, MAX_ATTEMPTS])).rows;
}

async function sendOne(claimed, db = pool) {
  const { rows: [p] } = await db.query('SELECT name, review_url FROM property WHERE id = $1', [claimed.property_id]);
  const { branding } = await resolveEmailBranding(claimed.property_id, undefined, undefined);
  const optOutUrl = `${OTA_API_BASE_URL}/api/review-opt-out/${claimed.id}`;
  try {
    const emailId = await sendReviewRequest({
      to: claimed.email, name: claimed.contact_name, propertyName: p.name, branding, reviewUrl: p.review_url, optOutUrl,
    });
    await db.query('UPDATE review_request SET resend_email_id = $1 WHERE id = $2', [emailId, claimed.id]);
  } catch (err) {
    console.error(`Review request ${claimed.id} failed:`, err.message);
    // Released for the retry sweep; attempts (already counted) bounds it.
    await db.query('UPDATE review_request SET sent_at = NULL WHERE id = $1', [claimed.id]);
  }
}

async function sweep(db = pool, at = new Date()) {
  const claimed = [...await claimRetries(db, at), ...await claimDue(db, at)];
  for (const row of claimed) {
    // Sequential, not Promise.all -- volumes are small (one property's
    // worth of finished visits per 15 minutes).
    await sendOne(row, db);
  }
  return claimed.length;
}

// Boot + every 15 minutes, same in-process setInterval pattern as
// availabilitySeeder.js/teeTimeSeeder.js.
function startReviewRequestJob() {
  const run = () =>
    sweep()
      .then((n) => { if (n > 0) console.log(`Review requests: sent ${n}`); })
      .catch((err) => console.error('Review request sweep failed:', err.message));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

module.exports = { claimDue, claimRetries, sweep, startReviewRequestJob, MAX_ATTEMPTS };
```

- [ ] **Step 4: Generalise `sendReviewRequest` in `src/lib/resend.js`**

Replace the function and the comment directly above it with:

```js
// Post-visit review request, one per guest per visit whatever they booked
// (src/lib/reviewRequester.js decides who and when). Every eligible guest
// gets the same words, per Google's review policy. `reviewUrl` is the
// property's "Ask for reviews" link; `optOutUrl` is this request's own
// unauthenticated, property-wide opt-out link.
async function sendReviewRequest({ to, name, propertyName, branding, reviewUrl, optOutUrl }) {
  if (!client) throw new Error('Resend not configured');
  const subject = `How was your visit to ${propertyName}?`;
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const note = `Thanks for visiting ${propertyName}. If you've got thirty seconds, a Google review makes a real difference to us.`;

  const text = [greeting, '', note, '', `Leave a Google review: ${reviewUrl}`, '', `Don't want these? Unsubscribe: ${optOutUrl}`].join('\n');

  const logoHtml = brandingHeaderHtml(branding, propertyName);
  const ctaHtml = `<div style="margin:20px 0;">
      <a href="${escapeHtml(reviewUrl)}" style="display:inline-block;background:${branding?.brand_color || '#1a1a1a'};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 22px;border-radius:6px;">Leave a Google review</a>
    </div>`;
  const unsubscribeHtml = `<a href="${escapeHtml(optOutUrl)}" style="color:#888;text-decoration:underline;">Don't want these? Unsubscribe</a>`;

  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <bookings@hotal.forge-build.co.uk>`,
    to,
    subject,
    text,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto;">
      ${logoHtml}
      <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 20px;">${escapeHtml(note)}</p>
      ${ctaHtml}
      <p style="margin:24px 0 0;font-size:12px;">${unsubscribeHtml}</p>
    </div>`,
  });
  if (error) throw new Error(error.message);
  return data.id;
}
```

Then check nothing else calls the old signature: `grep -rn "sendReviewRequest(" src` should list only `reviewRequester.js` and the definition. If `formatAppointmentDate` or `addressFooterHtml` are now unused, leave them: other emails use them (`grep` before deleting anything).

- [ ] **Step 5: Run the check**

Run: `node -r dotenv/config scripts/check-review-requests.js`
Expected: `all passed` (12 checks).

- [ ] **Step 6: Boot check**

Run `npm start` briefly (the job sweeps once at boot against the local DB). Expected: no `Review request sweep failed` line in the log; stop the server.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reviewRequester.js src/lib/resend.js scripts/check-review-requests.js
git commit -m "Review requests: one per visit across every module

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Property-wide opt-out

**Files:**
- Create: `src/controllers/reviews.js`, `src/routes/reviews.js`
- Modify: `src/app.js` (mount), `src/controllers/spa.js` (`reviewOptOut` delegates)
- Modify: `scripts/check-review-requests.js` (opt-out checks)

**Interfaces:**
- Consumes: `review_request` (Task 1).
- Produces: `optOut(db, propertyId, email) -> Promise<void>`, route `GET /api/review-opt-out/:request_id` (unauthenticated, HTML response).

- [ ] **Step 1: Add the failing checks** — in `scripts/check-review-requests.js`, add `const { optOut } = require('../src/controllers/reviews');` under the other require, and before the `} finally {` add:

```js
    await check('opt-out writer: lowercases, idempotent, then blocks claims', async () => {
      await optOut(db, P, ' Late@Example.com');
      await optOut(db, P, 'late@example.com');
      const { rows } = await db.query(`SELECT email FROM review_request_opt_out WHERE property_id = $1 AND email = 'late@example.com'`, [P]);
      assert.equal(rows.length, 1);
      await dinner('late@example.com', '2026-07-28', '19:00', '21:00');
      assert.deepEqual(mine(await claimDue(db, T('2026-07-28T21:00:00Z'))), []);
    });
```

Run: `node -r dotenv/config scripts/check-review-requests.js`
Expected: `Cannot find module '../src/controllers/reviews'`.

- [ ] **Step 2: `src/controllers/reviews.js`**

```js
const pool = require('../db');
const { escapeHtml } = require('../lib/resend');

// Property-scoped: opting out of one venue's review requests says nothing
// about another the same person visits. Shared by the per-request route
// below and the legacy spa route (controllers/spa.js reviewOptOut).
async function optOut(db, propertyId, email) {
  if (!email) return;
  await db.query(
    `INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, lower(trim($2))) ON CONFLICT DO NOTHING`,
    [propertyId, email]
  );
}

// GET, unauthenticated -- the request UUID is the capability (unguessable,
// only ever in that guest's own review email). Idempotent, so a mail
// client prefetching the link is harmless.
async function reviewOptOut(req, res, next) {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT rr.property_id, rr.email, p.name AS property_name
       FROM review_request rr JOIN property p ON p.id = rr.property_id WHERE rr.id = $1`,
      [req.params.request_id]
    );
    if (!r) return res.status(404).send('<p>That link is no longer valid.</p>');
    await optOut(pool, r.property_id, r.email);
    res.send(`<p>You won't be asked for a review by ${escapeHtml(r.property_name)} again.</p>`);
  } catch (err) {
    // A malformed UUID is a dead link, not a server error.
    if (err.code === '22P02') return res.status(404).send('<p>That link is no longer valid.</p>');
    next(err);
  }
}

module.exports = { optOut, reviewOptOut };
```

Check `escapeHtml` is exported from `src/lib/resend.js` (`grep -n "module.exports" src/lib/resend.js`). If it isn't, use the same import `controllers/spa.js` uses for `escapeHtml` (`grep -n "escapeHtml" src/controllers/spa.js | head -2`).

- [ ] **Step 3: `src/routes/reviews.js` and mount**

```js
const express = require('express');
const ctrl = require('../controllers/reviews');

const router = express.Router();
// Unauthenticated by design -- see controllers/reviews.js.
router.get('/:request_id', ctrl.reviewOptOut);

module.exports = router;
```

In `src/app.js`, next to the other route requires add `const reviewRoutes = require('./routes/reviews');`, and after `app.use('/api/billing', billingRoutes);` add `app.use('/api/review-opt-out', reviewRoutes);`.

- [ ] **Step 4: Legacy spa route delegates.** In `src/controllers/spa.js` `reviewOptOut`, replace the `INSERT INTO review_request_opt_out …` block with `await optOut(pool, appointment.property_id, appointment.contact_email);` and add `const { optOut } = require('./reviews');` at the top. Check there's no require cycle: `controllers/reviews.js` imports only `db` and `lib/resend`.

- [ ] **Step 5: Run the check and both routes**

Run: `node -r dotenv/config scripts/check-review-requests.js` → `all passed` (13).
Then with `npm start` running locally:
```bash
node -r dotenv/config -e "
const pool=require('./src/db');(async()=>{const {rows:[r]}=await pool.query('SELECT id FROM review_request LIMIT 1');console.log(r?.id||'none');await pool.end();})()"
curl -s localhost:3000/api/review-opt-out/<id-from-above>
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/review-opt-out/not-a-uuid
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/review-opt-out/00000000-0000-0000-0000-000000000000
```
Expected: the opt-out sentence for a real ID (if the local DB has no `review_request` rows, skip that one); `404` and `404` for the other two. Then remove that test opt-out row if you created one on real data: `DELETE FROM review_request_opt_out WHERE …` for that property and email.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/reviews.js src/routes/reviews.js src/app.js src/controllers/spa.js scripts/check-review-requests.js
git commit -m "Review requests: property-wide opt-out per request; spa link delegates

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: End-to-end send, then live rollout (with the user's OK)

**Files:** none (a throwaway script under `%TEMP%`).

- [ ] **Step 1: One real send locally.** With `RESEND_API_KEY` in `.env`, create a temporary property on the local DB with reviews on, delay 0, `review_url` set, and a reservation for the user's test inbox. Ask the user which address to use, never a guest's. Make it end 30 minutes ago and call `sweep()` once:

```js
// %TEMP%/review-e2e.js -- run: NODE_PATH=./node_modules node -r dotenv/config %TEMP%/review-e2e.js <test-inbox>
const path = require('path'); const repo = process.cwd();
const pool = require(path.join(repo, 'src/db'));
const { sweep } = require(path.join(repo, 'src/lib/reviewRequester'));
(async () => {
  const to = process.argv[2]; if (!to) throw new Error('pass the test inbox');
  const one = async (q, p) => (await pool.query(q, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, timezone, review_request_enabled, review_url, review_request_delay_mins) VALUES ('Review E2E', 'Europe/London', true, 'https://g.page/r/test/review', 0) RETURNING id`)).id;
  const R = (await one(`INSERT INTO restaurant (property_id, name, default_duration_minutes) VALUES ($1, 'Grill', 60) RETURNING id`, [P])).id;
  const Tb = (await one(`INSERT INTO restaurant_table (property_id, restaurant_id, table_number, seats) VALUES ($1, $2, 'E1', 2) RETURNING id`, [P, R])).id;
  await pool.query(`INSERT INTO restaurant_reservation (property_id, table_id, reservation_date, start_time, end_time, contact_name, contact_email, party_size)
    VALUES ($1, $2, (now() AT TIME ZONE 'Europe/London')::date, ((now() AT TIME ZONE 'Europe/London') - interval '90 minutes')::time, ((now() AT TIME ZONE 'Europe/London') - interval '30 minutes')::time, 'Test', $3, 2)`, [P, Tb, to]);
  console.log('sent', await sweep());
  console.log((await pool.query('SELECT id, sent_at, resend_email_id FROM review_request WHERE property_id = $1', [P])).rows);
  console.log('cleanup property', P);
  await pool.end();
})();
```

Expected: `sent 1`, a row with `resend_email_id`, and the email in the inbox with the right subject, button and unsubscribe link. Clicking unsubscribe on a local run hits the live host (`OTA_API_BASE_URL`), so check the opt-out route locally with curl instead. Clean up the temporary property's rows afterwards. (If the run is just after midnight local time, the "end 30 minutes ago" arithmetic wraps; rerun later.)

- [ ] **Step 2: Ask the user** before applying the migration to the live DB (`node scripts/run-migration.js src/db/migrate-2026-10-06-review-requests-all-modules.sql` applies to both; local is already done and idempotent) and before `git push`. The migration must reach the live DB **before** the push: the new job queries `review_candidate` at boot. Point out that every property with `review_request_enabled` now gets requests from all of its enabled modules, not just the spa.
