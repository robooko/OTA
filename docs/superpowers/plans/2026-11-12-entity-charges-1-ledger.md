# Entity Charges, Plan 1 of 3: the ledger for golf, hire and reservations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can see Charges / Paid / Balance, add a charge and record a payment on a golf booking, an equipment hire and a restaurant reservation, as they can on a room booking today.

**Architecture:** `payment` and `folio_adjustment` gain one nullable reference per entity with an exactly-one-owner check, so foreign keys are kept and existing room rows keep their meaning. A new `src/lib/entityFolio.js` computes an entity's folio live in the same shape as `computeFolio`, served by one generic router at `/api/folios/:kind/:id`. The staff app's room charges block is extracted into a shared module and opened from a "Charges" row action on the three list pages.

**Tech Stack:** Node 22 / Express / PostgreSQL (`pg`), check scripts with `node:assert/strict` (no test framework), MCP tools in `mcp-server/tools.js`; staff app is Astro + TypeScript with Playwright.

**Spec:** `C:\Users\robert\source\repos\OTA\docs\superpowers\specs\2026-11-12-entity-charges-design.md`

**The three plans.** This one covers spec steps 1 to 3. Plan 2: spa appointments on the ledger, spa deposit setting, spa payment flows charging the balance. Plan 3: amount due now, website-taken payments, enforcement. Do not start work from plans 2 or 3 here.

**Two repositories.** Tasks 1 to 4 are in `C:\Users\robert\source\repos\OTA`. Tasks 5 to 7 are in `C:\Users\robert\source\repos\ota-table-bookings`. Paths below are relative to the task's repository.

## Global Constraints

- Every query is scoped by `req.property_id`. Another property's row is a 404, never a 403 and never data.
- Money is `NUMERIC(14,2)`; responses carry amounts as two-decimal strings; sum in integer cents with `toCents` / `fromCents` from `src/lib/folio.js`.
- Errors respond `{ error, details? }` with 400 / 404 / 409 / 500.
- Schema changes ship as a dated `src/db/migrate-2026-11-12-<feature>.sql` **and** the same change in `src/db/schema.sql`.
- **Never run a migration against the live database.** `scripts/run-migration.js` applies to `DATABASE_URL_LIVE` whenever it is set. Always run it as `DATABASE_URL_LIVE= node scripts/run-migration.js <file>` (empty value, so dotenv does not fill it). Live migration and the push to `main` (which deploys) are Robert's, with his OK.
- Check scripts run against the local DB only and refuse a remote one (`/neon\.tech|render\.com/` on `DATABASE_URL`), build fixtures under a throwaway property and delete them at the end. Follow `scripts/check-cash-payments.js`.
- New routes need Swagger docs in `src/docs/swagger.js`, MCP tools in `mcp-server/tools.js`, and `node -r dotenv/config scripts/check-mcp-coverage.js` passing.
- Anti-goals from the spec: an existing room folio, spa bill or check-out gate must not change its numbers; no payment or adjustment may belong to no booking or to two.
- Folio kinds are the table names, exactly: `golf_booking`, `equipment_hire`, `restaurant_reservation`.
- Do not push either repository. Commit locally only.

## Review Focus

1. **A non-UUID id in the URL** (`/api/folios/golf_booking/abc`): expected 404, not a 500 from Postgres error `22P02`. Test in Task 3.
2. **An adjustment id that belongs to a different booking or kind** passed to DELETE: expected 404 and the row still present. Test in Task 3.
3. **Amounts that are not clean money** (`"abc"`, `0`, a negative payment, more than two decimals): expected 400 for a non-numeric or zero adjustment and for a non-numeric, zero or negative payment; an adjustment of `10.006` is stored as `10.01`. Tests in Task 3.
4. **A payment recorded on a cancelled booking, or more than is owed**: expected to succeed and show as a negative balance (a credit), because desk deposits and refunds-in-waiting are real. Test in Task 2 (compute) and Task 3 (route).
5. **A restaurant whose currency differs from the property's**: expected the folio's `currency` to be the restaurant's. Test in Task 2.

---

### Task 1: Payments and adjustments can belong to another kind of booking

**Files:**
- Create: `src/db/migrate-2026-11-12-entity-folios.sql`
- Modify: `src/db/schema.sql` (the `payment` table near line 443 and `folio_adjustment` near line 462)
- Create: `scripts/check-entity-folios.js`

**Interfaces:**
- Produces: on both `payment` and `folio_adjustment`, nullable columns `golf_booking_id`, `equipment_hire_id`, `restaurant_reservation_id`, `spa_appointment_id` (each `UUID REFERENCES <table>(id)`, no cascade); `booking_id` nullable; constraints `payment_one_owner` and `folio_adjustment_one_owner`. Plan 2 uses `spa_appointment_id`; nothing in this plan writes it.
- Produces: `scripts/check-entity-folios.js` with the harness later tasks add checks to: `P` (throwaway property id), `one(sql, params)`, `call(fn, req)`, `check(name, fn)`, and fixture helpers `golfBooking({ players, price, status })`, `hire({ quantity, total })`, `reservation({ partySize, intent, currency })`, each returning the new row's id.

- [ ] **Step 1: Write the check script with the failing schema checks**

Copy the harness from `scripts/check-cash-payments.js` (remote-DB refusal, `one`, `call`, `check`, cleanup in `finally`, non-zero exit when `failed > 0`). Give its fake `res` an `end()` that returns itself, since a 204 is sent with `res.status(204).end()`. Fixtures need a golf course and tee time, an equipment item, a restaurant with a table. First checks:

```js
await check('schema: a payment has exactly one owner', async () => {
  const g = await golfBooking({ players: 2, price: '180.00' });
  const h = await hire({ quantity: 1, total: '50.00' });
  await pool.query(`INSERT INTO payment (property_id, golf_booking_id, amount, status) VALUES ($1, $2, 10, 'completed')`, [P, g]);
  await assert.rejects(pool.query(`INSERT INTO payment (property_id, amount) VALUES ($1, 10)`, [P]), /payment_one_owner/);
  await assert.rejects(pool.query(`INSERT INTO payment (property_id, golf_booking_id, equipment_hire_id, amount) VALUES ($1, $2, $3, 10)`, [P, g, h]), /payment_one_owner/);
});
await check('schema: an adjustment has exactly one owner', async () => {
  const g = await golfBooking({ players: 1, price: '180.00' });
  await pool.query(`INSERT INTO folio_adjustment (property_id, golf_booking_id, description, amount) VALUES ($1, $2, 'Glove', 20)`, [P, g]);
  await assert.rejects(pool.query(`INSERT INTO folio_adjustment (property_id, description, amount) VALUES ($1, 'x', 1)`, [P]), /folio_adjustment_one_owner/);
});
```

Cleanup deletes this property's `payment` and `folio_adjustment` rows before the entities they reference.

- [ ] **Step 2: Run it and see it fail**

Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: both checks FAIL with `column "golf_booking_id" of relation "payment" does not exist`.

- [ ] **Step 3: Write the migration and mirror it in `schema.sql`**

```sql
-- Charges on every booking: payment and folio_adjustment can belong to a golf
-- booking, equipment hire, restaurant reservation or spa appointment, not
-- only a room booking. Exactly one owner per row. Existing rows keep booking_id.
BEGIN;
ALTER TABLE payment ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE payment
  ADD COLUMN IF NOT EXISTS golf_booking_id           UUID REFERENCES golf_booking(id),
  ADD COLUMN IF NOT EXISTS equipment_hire_id         UUID REFERENCES equipment_hire(id),
  ADD COLUMN IF NOT EXISTS restaurant_reservation_id UUID REFERENCES restaurant_reservation(id),
  ADD COLUMN IF NOT EXISTS spa_appointment_id        UUID REFERENCES spa_appointment(id);
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_one_owner;
ALTER TABLE payment ADD CONSTRAINT payment_one_owner CHECK
  (num_nonnulls(booking_id, golf_booking_id, equipment_hire_id, restaurant_reservation_id, spa_appointment_id) = 1);
COMMIT;
```

Repeat the same statements for `folio_adjustment` (constraint `folio_adjustment_one_owner`) inside the same transaction. Add one partial index per new column on each table, named `idx_<table>_<column>` with `WHERE <column> IS NOT NULL`. In `schema.sql`, change the two `CREATE TABLE` blocks to the final shape and add the indexes beside the existing ones; `schema.sql` must produce the same result on an empty database.

- [ ] **Step 4: Apply locally and re-run**

Run: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-11-12-entity-folios.sql`
Expected: `DATABASE_URL: ok` and `DATABASE_URL_LIVE: not set, skipped`.
Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: both checks `ok`.

- [ ] **Step 5: Confirm rooms are untouched**

Run: `node -r dotenv/config scripts/check-cash-payments.js` and `node -r dotenv/config scripts/check-multi-room-bookings.js`
Expected: every line `ok`, exit code 0, same as before the migration.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrate-2026-11-12-entity-folios.sql src/db/schema.sql scripts/check-entity-folios.js
git commit -m "Entity folios: payment and folio_adjustment can belong to golf, hire, reservation or spa"
```

---

### Task 2: Compute an entity's folio

**Files:**
- Create: `src/lib/entityFolio.js`
- Modify: `scripts/check-entity-folios.js`

**Interfaces:**
- Consumes: Task 1's columns; `toCents`, `fromCents` from `src/lib/folio.js`.
- Produces:
  - `ENTITY_KINDS: string[]` = `['golf_booking', 'equipment_hire', 'restaurant_reservation']`
  - `ownerColumn(kind: string): string` returns `` `${kind}_id` `` for a known kind, `null` otherwise
  - `async computeEntityFolio(kind, id, propertyId)` returns `null` for an unknown kind, a non-UUID id, or an entity not in that property; otherwise:

```js
{
  kind, id,
  status,              // the entity's own status string
  currency,            // ISO code
  items: [{ type, source_id?, description, amount, created_at? }],
  charges_total, payments, payments_total, balance,   // as computeFolio: strings, completed payments only
  external_payment,    // boolean
}
```

Rules the tests pin:
- `type: 'base'` is the entity's own price: golf `total_price`, described `<course name> · <n> player` / `players`; hire `COALESCE(total_price, 0)`, described `<equipment name>` or `<equipment name> × <quantity>` when quantity > 1. A restaurant reservation has no base item.
- The base item is left out when the entity's `status` is `cancelled`.
- Golf also lists its `golf_booking_item` rows as `type: 'item'`, described `<item_name>` or `<item_name> × <quantity>`, amount `unit_price × quantity`. These stay when the booking is cancelled.
- `type: 'adjustment'` rows come from `folio_adjustment` by the owner column, with `source_id` and `created_at`.
- `currency` is the property's, except a reservation uses `COALESCE(restaurant.currency, property.currency)`.
- `external_payment` is true only for a reservation whose `stripe_payment_intent_id` is not null.

- [ ] **Step 1: Add the failing checks**

```js
const { computeEntityFolio, ENTITY_KINDS, ownerColumn } = require('../src/lib/entityFolio');

await check('compute: golf base charge and balance', async () => {
  const g = await golfBooking({ players: 2, price: '180.00' });
  const f = await computeEntityFolio('golf_booking', g, P);
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].type, 'base');
  assert.match(f.items[0].description, / · 2 players$/);
  assert.equal(f.items[0].amount, '360.00');
  assert.deepEqual([f.charges_total, f.payments_total, f.balance], ['360.00', '0.00', '360.00']);
  assert.equal(f.external_payment, false);
});
await check('compute: golf purchases, adjustments and payments', async () => {
  const g = await golfBooking({ players: 1, price: '180.00' });
  await pool.query(`INSERT INTO golf_booking_item (property_id, booking_id, item_name, quantity, unit_price) VALUES ($1, $2, 'Balls', 2, 15.50)`, [P, g]);
  await pool.query(`INSERT INTO folio_adjustment (property_id, golf_booking_id, description, amount) VALUES ($1, $2, 'Comp', -10)`, [P, g]);
  await pool.query(`INSERT INTO payment (property_id, golf_booking_id, amount, status) VALUES ($1, $2, 100, 'completed'), ($1, $2, 50, 'pending')`, [P, g]);
  const f = await computeEntityFolio('golf_booking', g, P);
  assert.deepEqual(f.items.map((i) => [i.type, i.amount]), [['base', '180.00'], ['item', '31.00'], ['adjustment', '-10.00']]);
  assert.deepEqual([f.charges_total, f.payments_total, f.balance], ['201.00', '100.00', '101.00']);
});
await check('compute: a cancelled booking drops its base charge and shows a credit', async () => {
  const g = await golfBooking({ players: 2, price: '180.00', status: 'cancelled' });
  await pool.query(`INSERT INTO payment (property_id, golf_booking_id, amount, status) VALUES ($1, $2, 100, 'completed')`, [P, g]);
  const f = await computeEntityFolio('golf_booking', g, P);
  assert.equal(f.items.length, 0);
  assert.equal(f.balance, '-100.00');
});
await check('compute: hire with no price is a zero base charge', async () => {
  const h = await hire({ quantity: 3, total: null });
  const f = await computeEntityFolio('equipment_hire', h, P);
  assert.equal(f.items[0].amount, '0.00');
  assert.match(f.items[0].description, / × 3$/);
});
await check('compute: a reservation has no base charge, its own currency, and flags a Stripe deposit', async () => {
  const r = await reservation({ partySize: 4, intent: 'pi_check_1', currency: 'EUR' });
  const f = await computeEntityFolio('restaurant_reservation', r, P);
  assert.deepEqual(f.items, []);
  assert.equal(f.currency, 'EUR');
  assert.equal(f.external_payment, true);
  assert.equal(f.balance, '0.00');
});
await check('compute: unknown kind, bad id and another property are all null', async () => {
  const g = await golfBooking({ players: 1, price: '180.00' });
  assert.equal(await computeEntityFolio('booking', g, P), null);
  assert.equal(await computeEntityFolio('golf_booking', 'abc', P), null);
  assert.equal(await computeEntityFolio('golf_booking', g, '00000000-0000-0000-0000-000000000000'), null);
  assert.equal(ownerColumn('golf_booking'), 'golf_booking_id');
  assert.equal(ownerColumn('booking'), null);
  assert.deepEqual(ENTITY_KINDS, ['golf_booking', 'equipment_hire', 'restaurant_reservation']);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: FAIL `Cannot find module '../src/lib/entityFolio'`.

- [ ] **Step 3: Implement `src/lib/entityFolio.js`**

One config object per kind (the base-line query and how to describe it), one shared function for adjustments, payments and totals. The owner column name is only ever taken from `ownerColumn(kind)`, never from a request, since it is interpolated into SQL. Test a UUID with the same `UUID_RE` pattern other controllers use before querying.

- [ ] **Step 4: Run and see them pass**

Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: every line `ok`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entityFolio.js scripts/check-entity-folios.js
git commit -m "Entity folios: compute charges, paid and balance for golf, hire and reservations"
```

---

### Task 3: The folio routes, their docs and their MCP tools

**Files:**
- Create: `src/controllers/entityFolio.js`
- Create: `src/routes/folios.js`
- Modify: `src/app.js` (mount beside `app.use('/api/payments', paymentRoutes)`, line 101)
- Modify: `src/docs/swagger.js` (beside the `/api/bookings/{id}/folio` entries, line 606)
- Modify: `mcp-server/tools.js` (beside `get_booking_folio`, line 543)
- Modify: `scripts/check-entity-folios.js`

**Interfaces:**
- Consumes: `computeEntityFolio`, `ownerColumn` from Task 2.
- Produces, all guarded by `[authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')]` exactly as `src/routes/payments.js` does:

| Route | Handler | Success |
|---|---|---|
| `GET /api/folios/:kind/:id` | `getEntityFolio` | 200, the folio |
| `POST /api/folios/:kind/:id/adjustments` body `{ description, amount }` | `addEntityAdjustment` | 201, the row |
| `DELETE /api/folios/:kind/:id/adjustments/:adjustment_id` | `removeEntityAdjustment` | 204 |
| `POST /api/folios/:kind/:id/payments` body `{ amount, method? }` | `recordEntityPayment` | 201, the row |

- Errors: unknown kind, bad id, or entity not in the property is `404 { error: 'Not found' }` on every route. Adjustment: `400 { error: 'description and a non-zero amount are required' }`; description over 200 characters `400 { error: 'description must be 200 characters or fewer' }` (same text as `src/controllers/folio.js`). Payment: `400 { error: 'amount must be a positive number' }`. A missing adjustment, or one owned by a different booking, is `404 { error: 'Adjustment not found on this booking' }`.
- A recorded payment is always `status = 'completed'` with `paid_at = now()`; `method` is stored as given (`card`, `cash`, ...), null when absent. It is not capped at the balance and is allowed on a cancelled booking.
- MCP tools: `get_entity_folio`, `add_entity_folio_adjustment`, `remove_entity_folio_adjustment`, `record_entity_payment`. Each takes `kind` (zod enum of the three kinds) and `id`.

- [ ] **Step 1: Add the failing checks**

```js
const ctl = require('../src/controllers/entityFolio');
const at = (kind, id, extra = {}) => ({ params: { kind, id, ...extra.params }, body: extra.body ?? {} });

await check('routes: read, add a charge, remove it', async () => {
  const g = await golfBooking({ players: 2, price: '180.00' });
  assert.equal((await call(ctl.getEntityFolio, at('golf_booking', g))).body.balance, '360.00');
  const add = await call(ctl.addEntityAdjustment, at('golf_booking', g, { body: { description: 'Glove', amount: 10.006 } }));
  assert.equal(add.status, 201);
  assert.equal(add.body.amount, '10.01');
  assert.equal((await call(ctl.getEntityFolio, at('golf_booking', g))).body.balance, '370.01');
  const del = await call(ctl.removeEntityAdjustment, at('golf_booking', g, { params: { adjustment_id: add.body.id } }));
  assert.equal(del.status, 204);
});
await check('routes: adjustment validation', async () => {
  const g = await golfBooking({ players: 1, price: '180.00' });
  for (const body of [{ description: 'x', amount: 0 }, { description: 'x', amount: 'abc' }, { amount: 5 }, { description: 'y'.repeat(201), amount: 5 }]) {
    assert.equal((await call(ctl.addEntityAdjustment, at('golf_booking', g, { body }))).status, 400, JSON.stringify(body));
  }
});
await check('routes: record a payment, including on a cancelled booking and over the balance', async () => {
  const h = await hire({ quantity: 1, total: '50.00' });
  const pay = await call(ctl.recordEntityPayment, at('equipment_hire', h, { body: { amount: 80, method: 'cash' } }));
  assert.equal(pay.status, 201);
  assert.deepEqual([pay.body.status, pay.body.method, pay.body.equipment_hire_id], ['completed', 'cash', h]);
  assert.ok(pay.body.paid_at);
  assert.equal((await call(ctl.getEntityFolio, at('equipment_hire', h))).body.balance, '-30.00');
  const g = await golfBooking({ players: 1, price: '180.00', status: 'cancelled' });
  assert.equal((await call(ctl.recordEntityPayment, at('golf_booking', g, { body: { amount: 20 } }))).status, 201);
  for (const amount of [0, -5, 'abc', undefined]) {
    assert.equal((await call(ctl.recordEntityPayment, at('equipment_hire', h, { body: { amount } }))).status, 400, String(amount));
  }
});
await check('routes: unknown kind, bad id and another property are 404, never 500', async () => {
  const g = await golfBooking({ players: 1, price: '180.00' });
  const other = { property_id: '00000000-0000-0000-0000-000000000000' };
  for (const fn of [ctl.getEntityFolio, ctl.addEntityAdjustment, ctl.recordEntityPayment]) {
    const body = { description: 'x', amount: 5 };
    assert.equal((await call(fn, at('booking', g, { body }))).status, 404);
    assert.equal((await call(fn, at('golf_booking', 'abc', { body }))).status, 404);
    assert.equal((await call(fn, { ...at('golf_booking', g, { body }), ...other })).status, 404);
  }
});
await check('routes: an adjustment can only be removed through the booking that owns it', async () => {
  const a = await golfBooking({ players: 1, price: '180.00' });
  const b = await golfBooking({ players: 1, price: '180.00' });
  const h = await hire({ quantity: 1, total: '50.00' });
  const adj = (await call(ctl.addEntityAdjustment, at('golf_booking', a, { body: { description: 'Glove', amount: 10 } }))).body.id;
  assert.equal((await call(ctl.removeEntityAdjustment, at('golf_booking', b, { params: { adjustment_id: adj } }))).status, 404);
  assert.equal((await call(ctl.removeEntityAdjustment, at('equipment_hire', h, { params: { adjustment_id: adj } }))).status, 404);
  assert.equal((await call(ctl.removeEntityAdjustment, at('golf_booking', a, { params: { adjustment_id: 'abc' } }))).status, 404);
  assert.ok(await one('SELECT id FROM folio_adjustment WHERE id = $1', [adj]));
});
```

- [ ] **Step 2: Run and see them fail**

Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: FAIL `Cannot find module '../src/controllers/entityFolio'`.

- [ ] **Step 3: Implement the controller and router, and mount it**

Each handler first resolves the entity through `computeEntityFolio` (or a cheaper existence query through the same kind config) and returns the 404 above when it is null; nothing is written before that. Mount as `app.use('/api/folios', folioRoutes)`.

- [ ] **Step 4: Run and see them pass**

Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: every line `ok`.

- [ ] **Step 5: Add Swagger entries and the four MCP tools**

Swagger: four operations under tag `Folio`, `security: STAFF_OR_FULL_KEY`, `kind` documented as an enum of the three kinds. MCP tool descriptions say what a folio is for these bookings and that only completed payments reduce the balance, in the style of `get_booking_folio` and `record_payment`.

- [ ] **Step 6: Check MCP coverage**

Run: `node -r dotenv/config scripts/check-mcp-coverage.js`
Expected: ends with `ok`, and no `/api/folios` route under "routes with no MCP tool".

- [ ] **Step 7: Commit**

```bash
git add src/controllers/entityFolio.js src/routes/folios.js src/app.js src/docs/swagger.js mcp-server/tools.js scripts/check-entity-folios.js
git commit -m "Entity folios: /api/folios routes, docs and MCP tools"
```

---

### Task 4: A restaurant's deposit is per table or per guest

**Files:**
- Create: `src/db/migrate-2026-11-12-restaurant-protection-basis.sql`
- Modify: `src/db/schema.sql` (the `restaurant` table, beside `payment_protection_amount`, line 807)
- Modify: `src/controllers/restaurant.js` (`createRestaurant` near line 59, `updateRestaurant` near line 92)
- Modify: `src/docs/swagger.js`, `mcp-server/tools.js` (`create_restaurant`, `update_restaurant`)
- Modify: `scripts/check-entity-folios.js`

**Interfaces:**
- Produces: `restaurant.payment_protection_basis VARCHAR(10) NOT NULL DEFAULT 'per_table'`, constraint `restaurant_payment_protection_basis_check` allowing `'per_table'` and `'per_guest'`. Accepted on create and update, returned wherever a restaurant is returned. An invalid value is `400 { error: 'payment_protection_basis must be one of: per_table, per_guest' }`. Nothing computes with it yet; plan 3 does.

- [ ] **Step 1: Add the failing check**

```js
const restaurants = require('../src/controllers/restaurant');
await check('restaurant: deposit basis defaults to per_table and can be set to per_guest', async () => {
  const made = await call(restaurants.createRestaurant, { body: { name: 'Basis', default_duration_minutes: 90 } });
  assert.equal(made.body.payment_protection_basis, 'per_table');
  const id = made.body.id;
  const put = await call(restaurants.updateRestaurant, { params: { id }, body: { payment_protection_basis: 'per_guest' } });
  assert.equal(put.body.payment_protection_basis, 'per_guest');
  assert.equal((await call(restaurants.updateRestaurant, { params: { id }, body: { name: 'Basis 2' } })).body.payment_protection_basis, 'per_guest');
  assert.equal((await call(restaurants.updateRestaurant, { params: { id }, body: { payment_protection_basis: 'per_person' } })).status, 400);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: the new check FAILS with `undefined !== 'per_table'`; all earlier checks still `ok`.

- [ ] **Step 3: Migration, schema, controller**

Migration adds the column and constraint (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`). In the controller, validate beside `isValidPaymentProtection` and write it with `COALESCE($n, payment_protection_basis)` on update so an update that omits it leaves it alone.

- [ ] **Step 4: Apply locally and re-run**

Run: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-11-12-restaurant-protection-basis.sql`
Run: `node -r dotenv/config scripts/check-entity-folios.js`
Expected: every line `ok`.

- [ ] **Step 5: Docs and MCP tool schemas**

Add `payment_protection_basis` (enum) to the restaurant create and update schemas in `swagger.js` and to the `create_restaurant` and `update_restaurant` tool inputs, described as "whether payment_protection_amount is charged once per table or once per guest".
Run: `node -r dotenv/config scripts/check-mcp-coverage.js`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrate-2026-11-12-restaurant-protection-basis.sql src/db/schema.sql src/controllers/restaurant.js src/docs/swagger.js mcp-server/tools.js scripts/check-entity-folios.js
git commit -m "Restaurant deposit amount is per table or per guest"
```

---

### Task 5 (staff app): one shared charges block

Repository: `C:\Users\robert\source\repos\ota-table-bookings`. Needs the OTA API from Tasks 1 to 3 running locally.

**Files:**
- Create: `src/scripts/charges-block.ts`
- Modify: `src/scripts/room-bookings-client.ts` (remove the local `Folio` type and `fillCharges`, lines 93 to 152; call the shared one at line 589)
- Modify: `src/styles/global.css` and `src/pages/room-bookings.astro` (the `.rbd-charge*` rules must apply on every page that shows the block)

**Interfaces:**
- Produces:

```ts
export type ChargesOptions = {
  /** GET returns the folio; `${folioPath}/adjustments` adds and removes charges. */
  folioPath: string;
  /** POST target for "Record payment". */
  paymentPath: string;
  /** Merged into the payment body beside { amount, method }. */
  paymentBody?: Record<string, unknown>;
  /** Text glued before each amount. When absent, amounts use formatMoney with the folio's currency. */
  currencyPrefix?: string;
  /** Show the payment form even when nothing is owed, with no upper limit. */
  allowPrepay?: boolean;
};
export async function fillCharges(el: HTMLElement, opts: ChargesOptions): Promise<void>;
```

- Behaviour beyond today's room block:
  - A negative balance is labelled `Credit` and shown as a positive amount; zero or positive stays `Balance`.
  - When the folio has `external_payment: true`, one extra line with no amount reads `Card deposit or hold on Stripe`.
  - Forms are found by class inside `el` (`.charges-add`, `.charges-pay`), not by document-wide id, so two blocks never collide.
- The room panel calls it with `{ folioPath: '/api/bookings/<id>/folio', paymentPath: '/api/payments', paymentBody: { booking_id: id, status: 'completed' }, currencyPrefix: currency }` and must look and behave exactly as before.

- [ ] **Step 1: Run the existing room spec to record the baseline**

Run: `npx playwright test tests/rooms.spec.ts`
Expected: PASS. Note the count of passing tests.

- [ ] **Step 2: Extract `fillCharges` into `src/scripts/charges-block.ts` with the options above and switch the room panel to it**

Move the `.rbd-charge-form`, `.rbd-charge-remove` and `.rbd-charges-totals` rules out of `room-bookings.astro` into `global.css` unchanged, so the other pages get them.

- [ ] **Step 3: Re-run the room spec**

Run: `npx playwright test tests/rooms.spec.ts`
Expected: PASS, same count as Step 1.

- [ ] **Step 4: Check the room panel by hand**

Run `astro dev --background`, open a room booking with a balance, and confirm: charges list, Paid and Balance read as before; adding a charge of `-5` and removing it updates the balance; "Record payment" is offered only while something is owed.

- [ ] **Step 5: Type-check and commit**

Run: `npx astro check`
Expected: 0 errors.

```bash
git add src/scripts/charges-block.ts src/scripts/room-bookings-client.ts src/styles/global.css src/pages/room-bookings.astro
git commit -m "Charges block shared between booking kinds"
```

---

### Task 6 (staff app): Charges on golf bookings, equipment hires and reservations

**Files:**
- Create: `src/components/ChargesDialog.astro`
- Create: `src/scripts/charges-dialog.ts`
- Modify: `src/pages/golf-bookings.astro`, `src/pages/equipment-hires.astro`, `src/pages/reservations.astro` (include the dialog)
- Modify: `src/scripts/golf-bookings-client.ts` (`actionsHtml` line 31, `wireRowActions` line 39), `src/scripts/equipment-hires-client.ts` (`actionsHtml` line 29, `wireRowActions` line 33), `src/scripts/reservations-client.ts` (`actionsHtml` line 20, `wireRowActions` line 27)
- Create: `tests/entity-charges.spec.ts`

**Interfaces:**
- Consumes: `fillCharges`, `ChargesOptions` from Task 5; `/api/folios/:kind/:id` from Task 3.
- Produces:
  - `ChargesDialog.astro`: `<dialog id="charges-dialog" class="list-dialog">` with a header `<h2 id="charges-dialog-title">`, a body `<div id="charges-dialog-body">` and a footer close button `#charges-dialog-close-btn`, in the same markup pattern as `#items-dialog` in `golf-bookings.astro`.
  - `export function openChargesDialog(kind: 'golf_booking' | 'equipment_hire' | 'restaurant_reservation', id: string, title: string): void` sets the title to `Charges · <title>`, fills the body with `fillCharges(body, { folioPath: '/api/folios/<kind>/<id>', paymentPath: '/api/folios/<kind>/<id>/payments', allowPrepay: true })` and calls `showModal()`.
  - Each list's row actions gain `<button class="charges-btn" data-id="...">Charges</button>`, enabled on cancelled rows too (staff must still see what was taken). `title` is the row's contact name.

- [ ] **Step 1: Write the failing Playwright spec**

Follow `tests/core-flows.spec.ts` for sign-in state and for creating a restaurant and a reservation. One serial chain:

```ts
test('a reservation shows charges, takes a charge and a payment', async ({ page }) => {
  await page.goto(`/reservations?restaurant_id=${restaurantId}`);
  await page.locator('#reservations-body tr .charges-btn').first().click();
  const dlg = page.locator('#charges-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.rbd-charges-totals')).toContainText('Balance');
  await dlg.locator('.charges-add [name=description]').fill('Corkage');
  await dlg.locator('.charges-add [name=amount]').fill('15');
  await dlg.locator('.charges-add button').click();
  await expect(dlg.locator('.reply-extras-list').first()).toContainText('Corkage');
  await dlg.locator('.charges-pay [name=amount]').fill('40');
  await dlg.locator('.charges-pay button').click();
  await expect(dlg.locator('.rbd-charges-totals')).toContainText('Credit');
  await expect(dlg.locator('.rbd-charges-totals')).toContainText('25');
});
```

Add the same shape for a golf booking (base line contains `player`, payment brings the balance down) if `tests/` already has a way to create a golf course and tee time; if it does not, cover golf and hire in Step 4 by hand and say so in the commit message.

- [ ] **Step 2: Run and see it fail**

Run: `npx playwright test tests/entity-charges.spec.ts`
Expected: FAIL, no element matches `.charges-btn`.

- [ ] **Step 3: Build the dialog, `openChargesDialog`, and the three row actions**

- [ ] **Step 4: Run the spec, then check golf and hire by hand**

Run: `npx playwright test tests/entity-charges.spec.ts`
Expected: PASS.
By hand on `/golf-bookings` and `/equipment-hires`: the base line shows the booking's own price; a cancelled row's dialog shows no base line; pro-shop items added through "Items" appear as charges.

- [ ] **Step 5: Type-check and commit**

Run: `npx astro check`
Expected: 0 errors.

```bash
git add src/components/ChargesDialog.astro src/scripts/charges-dialog.ts src/pages/golf-bookings.astro src/pages/equipment-hires.astro src/pages/reservations.astro src/scripts/golf-bookings-client.ts src/scripts/equipment-hires-client.ts src/scripts/reservations-client.ts tests/entity-charges.spec.ts
git commit -m "Charges on golf bookings, equipment hires and reservations"
```

---

### Task 7 (staff app): the per table / per guest setting

**Files:**
- Modify: `src/pages/restaurant-dashboard.astro` (beside `#restaurant-config-payment-protection`, line 229)
- Modify: `src/scripts/restaurant-dashboard-client.ts` (fill on open near line 341; autosave near line 398; `CONFIG_FIELD_LABELS`)

**Interfaces:**
- Consumes: `payment_protection_basis` from Task 4.
- Produces: a `<select id="restaurant-config-payment-basis">` with options `per_table` ("Per table") and `per_guest` ("Per guest"), labelled "Amount applies", in the same row group as the amount input and hidden with it (through `setAmountRowVisibility`) when the mode is `none`. It autosaves on change through `saveField({ payment_protection_basis: value }, [select])`, with field label `Deposit basis`.

- [ ] **Step 1: Add the select, fill it on open, save it on change**

- [ ] **Step 2: Check by hand**

Open a restaurant's settings sheet: with "Require for reservations" on `none` the select is hidden; on `deposit` it shows `Per table`; changing it to `Per guest` toasts "Deposit basis saved" and survives a reload.

- [ ] **Step 3: Type-check and commit**

Run: `npx astro check`
Expected: 0 errors.

```bash
git add src/pages/restaurant-dashboard.astro src/scripts/restaurant-dashboard-client.ts
git commit -m "Restaurant settings: deposit amount per table or per guest"
```

---

## Shipping (Robert)

Not part of any task; listed so nothing is assumed.

1. Run both migrations on the live database, with Robert's OK, before pushing OTA: `node scripts/run-migration.js src/db/migrate-2026-11-12-entity-folios.sql`, then the restaurant one.
2. Push OTA `main` (deploys to Render).
3. Deploy the staff app after the API is live; its "Charges" action 404s against an older API.
