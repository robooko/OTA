# Entity Charges, Plan 2 of 3: spa appointments on the ledger

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A spa appointment has Charges / Paid / Balance like every other booking, each spa can be set to take no payment, a deposit or full payment at booking, and the spa's card, cash, invoice and guest-bill flows charge what is still owed rather than the full price.

**Architecture:** `spa_appointment` becomes a fourth kind in `src/lib/entityFolio.js`. `payment` rows (owned through `payment.spa_appointment_id`, added in plan 1) become the only record of what an appointment has paid: a migration backfills one row for every appointment already marked paid, the import writes one per paid row, and every spa payment flow records one. `payment_status` is kept for its existing readers and is derived from the folio after every write by one helper, `syncSpaPaymentStatus`. The staff app opens the shared Charges dialog from a new "Charges" button in hotal-ui's spa feed popover.

**Tech Stack:** Node 22 / Express / PostgreSQL (`pg`), check scripts with `node:assert/strict` and `scripts/fake-stripe.js`; hotal-ui is Svelte 5 web components; the staff app is Astro + TypeScript with Playwright.

**Spec:** `C:\Users\robert\source\repos\OTA\docs\superpowers\specs\2026-11-12-entity-charges-design.md` (read "Rules", "Answered by Robert" item 1 and "Deposit rules"). Plan 1, whose code this builds on: `docs/superpowers/plans/2026-11-12-entity-charges-1-ledger.md`.

**Three repositories.** Tasks 1 to 4 are in `C:\Users\robert\source\repos\OTA`. Task 5 is in `C:\Users\robert\source\repos\hotal-ui`. Tasks 6 and 7 are in `C:\Users\robert\source\repos\ota-table-bookings`. Paths are relative to the task's repository.

## Decisions this plan makes (calls, recorded in the spec by Task 1)

- **Backfill instead of a read-time Paid line.** The spec suggested showing a Paid line at read time for an appointment marked paid with no `payment` row. That breaks the moment such an appointment gets its first real payment row: the synthetic line vanishes and the price is owed again. A one-off backfill plus a payment row from the import keeps one source of truth.
- **`payment_status`** is `'paid'` exactly when the appointment has completed payments and its balance is zero or less; otherwise `'unpaid'`. It is recomputed after every payment or charge change, so adding a charge to a paid appointment makes it unpaid again.
- **Stay-linked appointments** (`spa_appointment.booking_id` set) report `charged_to_booking_id`. `/api/folios` refuses charges and payments on them (409) so nothing is owed in two places. The spa flows still work on them, charging the balance, and set `payment_status` as today, which is what the room folio reads. The room folio is not touched.
- **Stripe references.** A payment from a terminal tap stores the PaymentIntent id (`pi_…`) in `payment.stripe_payment_intent_id`. A payment from a paid invoice stores the Invoice id (`in_…`) in the same column. It is the dedupe key: the same Stripe object is never recorded twice for one appointment. Nothing refunds through this column for spa rows.
- **Money taken is recorded as taken.** A succeeded intent or paid invoice is recorded at Stripe's amount even when it no longer equals the balance. `payment_status` follows the balance. This replaces the old "amount must equal the treatment price" 409s.

## Global Constraints

- Everything in plan 1's Global Constraints still holds: property scoping (another property's row is a 404), money as two-decimal strings summed in cents with `toCents` / `fromCents`, dated migration plus the same change in `schema.sql`, Swagger + MCP + `check-mcp-coverage.js` for API changes, no commits pushed.
- **Never run a migration against the live database.** Always `DATABASE_URL_LIVE= node scripts/run-migration.js <file>`. Live migration and the push are Robert's, with his OK.
- Anti-goal: an existing room folio, spa bill or check-out gate must not change its numbers. For an appointment with no added charges and no partial payment, every spa flow charges exactly what it charged before.
- Stripe amounts cross the boundary through `toStripeAmount` / `fromStripeAmount` (`src/lib/stripeAmount.js`), invoices included.
- New spa setting values, exactly: `spa.payment_required` in `'none' | 'deposit' | 'full'`, default `'none'`; `spa.deposit_amount` `NUMERIC(14,2)`, null or > 0, required when `payment_required = 'deposit'`. Nothing enforces them in this plan (plan 3 does).
- **hotal-ui is never published from here** (Robert publishes). Its change is made on a branch in a worktree, because hotal-ui's main working tree holds Robert's uncommitted work. Do not touch that working tree.

## Review Focus

1. **Deposit paid online, rest at the desk in cash.** The appointment's stored intent is `succeeded` and already recorded. Cash must take the remainder, not 409 "already paid by card". Test in Task 3.
2. **A retried confirm-payment, or a paid invoice re-checked.** No second `payment` row for the same Stripe object. Test in Task 3.
3. **A charge added after the appointment was paid.** `payment_status` goes back to `unpaid`, and the next tap charges just the new amount. Test in Tasks 2 and 3.
4. **A stay-linked appointment.** `/api/folios` adjustments and payments 409, and the room folio's numbers are unchanged. Test in Task 2.
5. **The backfill run twice, or run on an appointment that already has a payment row.** No duplicate rows. Test in Task 1.

---

### Task 1: Spa appointments on the ledger, with every past payment on record

**Files:**
- Modify: `src/lib/entityFolio.js`
- Create: `src/db/migrate-2026-11-12-spa-payments-backfill.sql`
- Modify: `src/controllers/spa.js` (`importAppointments`, the INSERT near line 1759)
- Modify: `scripts/check-entity-folios.js`, `scripts/check-bulk-imports.js` (cleanup deletes `payment` rows before `spa_appointment`)
- Modify: the spec (`docs/superpowers/specs/2026-11-12-entity-charges-design.md`): replace "there is no backfill" in "Answered by Robert" item 1 with the backfill call and its reason, and add the stay-linked and Stripe-reference calls from this plan under it

**Interfaces:**
- Produces: `ENTITY_KINDS` includes `'spa_appointment'`. `findEntity(kind, id, propertyId, db = pool)` and `computeEntityFolio(kind, id, propertyId, db = pool)`: the optional `db` is a `pg` client so callers inside a transaction see their own writes. Every folio gains `charged_to_booking_id` (uuid or `null`; non-null only for a stay-linked spa appointment).
- Produces, in `check-entity-folios.js`, fixtures `spaAppointment({ price, paid, bookingId, status })` and `roomBooking()` (a minimal `booking` row under `P`), each returning the id; Tasks 2 and 4 use them. Task 2 also imports `computeFolio` from `src/lib/folio.js`, and Task 3's checks import the controllers in `src/controllers/entityFolio.js` as `folios`.
- Spa folio: base line `{ type: 'base', description: <treatment name>, amount: COALESCE(sa.price, st.price, 0) }`, dropped when cancelled (the existing generic rule); currency is the property's; `external_payment` is `false`.

- [ ] **Step 1: Write the failing checks** in `check-entity-folios.js`. Add a fixture `spaAppointment({ price = '80.00', paid = false, bookingId = null, status = 'confirmed' })` (spa, therapist, treatment priced `90.00`; the appointment's frozen price is `price`, so the checks see the frozen price win), and add `spa_appointment`, `spa_treatment`, `spa_therapist`, `spa`, `booking` to the cleanup in dependency order.

```js
await check('spa: folio charges the frozen price, payments come from payment rows', async () => {
  const a = await spaAppointment({ price: '80.00' });
  await pool.query(`INSERT INTO payment (property_id, spa_appointment_id, amount, status, paid_at) VALUES ($1, $2, 20, 'completed', now())`, [P, a]);
  const f = await computeEntityFolio('spa_appointment', a, P);
  assert.deepEqual(f.items.map((i) => [i.type, i.amount]), [['base', '80.00']]);
  assert.equal(f.payments_total, '20.00'); assert.equal(f.balance, '60.00');
  assert.equal(f.charged_to_booking_id, null);
});
await check('spa: stay-linked appointment names its room booking', async () => {
  const b = await roomBooking();               // minimal booking row under P
  const a = await spaAppointment({ bookingId: b });
  assert.equal((await computeEntityFolio('spa_appointment', a, P)).charged_to_booking_id, b);
});
await check('spa: backfill records a paid appointment once, and only once', async () => {
  const a = await spaAppointment({ price: '80.00', paid: true });   // payment_status 'paid', payment_method 'cash', no payment row
  const b = await spaAppointment({ price: '80.00', paid: true });
  await pool.query(`INSERT INTO payment (property_id, spa_appointment_id, amount, status, paid_at) VALUES ($1, $2, 80, 'completed', now())`, [P, b]);
  const sql = fs.readFileSync('src/db/migrate-2026-11-12-spa-payments-backfill.sql', 'utf8');
  await pool.query(sql); await pool.query(sql);
  const rows = (id) => pool.query('SELECT amount, method FROM payment WHERE spa_appointment_id = $1', [id]).then((r) => r.rows);
  assert.deepEqual(await rows(a), [{ amount: '80.00', method: 'cash' }]);
  assert.equal((await rows(b)).length, 1);
  assert.equal((await computeEntityFolio('spa_appointment', a, P)).balance, '0.00');
});
```

`check-bulk-imports.js`: in the existing import check, the paid cash appointment `a1` now has exactly one `payment` row (amount = its price, method `'cash'`, `paid_at` = its `paid_at`), the unpaid cancelled `a2` has none, and re-importing the same batch adds none.

- [ ] **Step 2: Run both and see the new checks fail**

Run: `node -r dotenv/config scripts/check-entity-folios.js` and `node -r dotenv/config scripts/check-bulk-imports.js`
Expected: the new checks FAIL (`computeEntityFolio` returns null for `spa_appointment`; the migration file is missing; no payment row from the import).

- [ ] **Step 3: Implement**
  - `entityFolio.js`: the `spa_appointment` entry in `KINDS` (row joins `spa_treatment` and `property`, selects `sa.booking_id AS charged_to_booking_id`); thread `db` through `findEntity`, `lines` and the two folio queries; return `charged_to_booking_id: entity.charged_to_booking_id ?? null`.
  - The migration: one `INSERT INTO payment (property_id, spa_appointment_id, amount, method, status, stripe_payment_intent_id, paid_at) SELECT … FROM spa_appointment sa JOIN spa_treatment st …` for `payment_status = 'paid'` and `COALESCE(sa.price, st.price, 0) > 0` and `NOT EXISTS` a payment row for that appointment. Carry `sa.payment_method`, `sa.stripe_payment_intent_id`, `COALESCE(sa.paid_at, now())`. No `schema.sql` change (data only).
  - `importAppointments`: turn the INSERT into a CTE that also inserts a payment row for each newly inserted paid row with a price above zero (same columns as the backfill, `paid_at` from the inserted row). Rows lost to `ON CONFLICT` get none, so a re-import adds nothing.

- [ ] **Step 4: Apply the migration locally and rerun**

Run: `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-11-12-spa-payments-backfill.sql`, then both check scripts.
Expected: all ok; `check-cash-payments.js` and `check-multi-room-bookings.js` still exit 0.

- [ ] **Step 5: Commit** — `git commit -m "Spa appointments on the ledger; past spa payments backfilled as payment rows"` (with the spec edit).

---

### Task 2: `payment_status` follows the balance; folio routes on spa

**Files:**
- Create: `src/lib/spaLedger.js`
- Modify: `src/controllers/entityFolio.js`
- Modify: `scripts/check-entity-folios.js`

**Interfaces:**
- Consumes: `computeEntityFolio(kind, id, propertyId, db)` and `findEntity` from Task 1.
- Produces, in `src/lib/spaLedger.js`:
  - `syncSpaPaymentStatus(db, appointmentId, propertyId) -> Promise<appointment row | null>`: recomputes the folio with `db` and updates `spa_appointment`: `payment_status` per the rule in "Decisions"; when paid, `paid_at = COALESCE(paid_at, now())` and `payment_method` = method of the newest completed payment; when unpaid, `paid_at` and `payment_method` null. Returns the updated row (`SELECT *`).
  - `recordSpaPayment(appointmentId, propertyId, { method, stripeRef = null, cents = undefined }) -> Promise<{ appointment, recorded: boolean } | null>`: in one transaction, locks the appointment (`SELECT … FOR UPDATE`, scoped by property; `null` when absent or a malformed id). With `stripeRef` already recorded on this appointment it records nothing (`recorded: false`). `cents` undefined means "the balance under the lock"; if that is zero or less it records nothing. Otherwise inserts a completed payment (`paid_at = now()`), then `syncSpaPaymentStatus` with the same client. Returns the synced row.
- `/api/folios` on a spa appointment: `POST …/adjustments` and `POST …/payments` return 409 `{ error: 'Charged to the room booking -- use its folio', booking_id }` when `charged_to_booking_id` is set. After an adjustment is added or removed, or a payment recorded, on any spa appointment, `syncSpaPaymentStatus(pool, id, property)` runs.

- [ ] **Step 1: Write the failing checks**

```js
await check('spa: payment_status follows the balance through the folio routes', async () => {
  const a = await spaAppointment({ price: '80.00' });
  const status = async () => (await one('SELECT payment_status, payment_method FROM spa_appointment WHERE id = $1', [a]));
  await call(ctl.recordEntityPayment, at('spa_appointment', a, { body: { amount: 30, method: 'card' } }));
  assert.equal((await status()).payment_status, 'unpaid');
  await call(ctl.recordEntityPayment, at('spa_appointment', a, { body: { amount: 50, method: 'cash' } }));
  assert.deepEqual(await status(), { payment_status: 'paid', payment_method: 'cash' });
  const add = await call(ctl.addEntityAdjustment, at('spa_appointment', a, { body: { description: 'Oil', amount: 12 } }));
  assert.equal((await status()).payment_status, 'unpaid');
  await call(ctl.removeEntityAdjustment, at('spa_appointment', a, { params: { adjustment_id: add.body.id } }));
  assert.equal((await status()).payment_status, 'paid');
});
await check('spa: stay-linked appointment refuses charges and payments; room folio unchanged', async () => {
  const b = await roomBooking();
  const a = await spaAppointment({ bookingId: b });
  const before = await computeFolio(b, P);
  assert.equal((await call(ctl.addEntityAdjustment, at('spa_appointment', a, { body: { description: 'x', amount: 5 } }))).status, 409);
  const pay = await call(ctl.recordEntityPayment, at('spa_appointment', a, { body: { amount: 5 } }));
  assert.equal(pay.status, 409); assert.equal(pay.body.booking_id, b);
  assert.deepEqual(await computeFolio(b, P), before);
});
await check('spa: recordSpaPayment takes the balance once, dedupes a Stripe ref', async () => {
  const a = await spaAppointment({ price: '80.00' });
  assert.equal((await recordSpaPayment(a, P, { method: 'cash' })).appointment.payment_status, 'paid');
  assert.equal(await recordSpaPayment(a, P, { method: 'cash' }), null);            // nothing owed
  const b = await spaAppointment({ price: '80.00' });
  await recordSpaPayment(b, P, { method: 'card', stripeRef: 'pi_x', cents: 2000 });
  assert.equal((await recordSpaPayment(b, P, { method: 'card', stripeRef: 'pi_x', cents: 2000 })).recorded, false);
  assert.equal((await computeEntityFolio('spa_appointment', b, P)).payments_total, '20.00');
  assert.equal(await recordSpaPayment('abc', P, { method: 'cash' }), null);
});
```

- [ ] **Step 2: Run** `node -r dotenv/config scripts/check-entity-folios.js`. Expected: the three new checks FAIL.
- [ ] **Step 3: Implement** `src/lib/spaLedger.js` and the `entityFolio.js` controller changes as in Interfaces.
- [ ] **Step 4: Run** the same script. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Spa payment_status follows the folio balance; stay-linked appointments charge the room"`

---

### Task 3: The spa payment flows charge the balance

**Files:**
- Modify: `src/controllers/spaPayments.js`
- Modify: `scripts/check-cash-payments.js` (spa section; the fake billing object gains what the invoice paths call; cleanup deletes `payment` rows before `spa_appointment`)

**Interfaces:**
- Consumes: `computeEntityFolio` (Task 1), `recordSpaPayment` (Task 2), `toStripeAmount` / `fromStripeAmount`.
- Behaviour, per function. "Owed" is the spa folio's balance in cents. Where a function used to 409 on `payment_status === 'paid'`, it now 409s when owed ≤ 0, with `'Appointment already paid'` if `payment_status` is `'paid'`, else `'Nothing to pay on this appointment'`.
  - `createAppointmentPaymentIntent`: the intent is for owed. An existing intent still awaiting a card is reused. If its amount differs and its status is `requires_payment_method`, it is first updated to owed (`paymentIntents.update`). An existing `succeeded` intent is recorded (`recordSpaPayment` with `stripeRef` = its id, `cents` = `fromStripeAmount(amount)`). If nothing is owed after that, respond `{ already_paid: true, payment_intent_id }`; otherwise fall through and mint a fresh intent for the remainder.
  - `confirmAppointmentPayment` (card): the intent must still match the stored id and be succeeded; the amount check is removed; record it as above. Respond 200 with the synced appointment row, also on a retry.
  - `recordCashPayment`: a stored intent that is `succeeded` **and already recorded** no longer blocks; one succeeded but unrecorded still 409s "already paid by card"; the other Stripe clean-up is unchanged. Then `recordSpaPayment(…, { method: 'cash' })`; `null` → 409 `'Appointment already paid'`.
  - `createAppointmentInvoice`, `addAppointmentToBill`: the line amount is `toStripeAmount(owed)`.
  - `settlePaidInvoice(stripe, invoice, propertyId)`: for each line, `recordSpaPayment(id, propertyId, { method: 'card', stripeRef: invoice.id, cents: fromStripeAmount(line amount, invoice.currency) })`. Returns `settled` = ids now `paid` and `mismatched` = ids that still owe (or were not found). `createAppointmentInvoice` on a paid invoice whose appointment still owes returns 409 `'Invoice was paid but a balance remains'`.
  - `invoiceGuestBill`: each pending line is repriced to its appointment's owed (Stripe units). It is deleted when the appointment is missing, cancelled or owes nothing.

- [ ] **Step 1: Write the failing checks** in the spa section. Keep the existing five spa checks passing unchanged, except the "already paid" assertion, which still expects 409.

```js
await check('spa: deposit by card, the rest in cash', async () => {
  const a = await book();                                           // price 80
  const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
  fakeStripe.store.get(pi.body.payment_intent_id).amount = 2000;    // a 20.00 deposit taken
  fakeStripe.store.get(pi.body.payment_intent_id).status = 'succeeded';
  assert.equal((await pay(a, { stripe_payment_intent_id: pi.body.payment_intent_id })).status, 200);
  assert.equal((await pay(a, { stripe_payment_intent_id: pi.body.payment_intent_id })).status, 200);   // retry
  assert.equal((await appt(a)).payment_status, 'unpaid');
  const cash = await pay(a, { paid_with: 'cash' });
  assert.equal(cash.status, 200, JSON.stringify(cash.body));
  assert.deepEqual((await pool.query('SELECT amount, method FROM payment WHERE spa_appointment_id = $1 ORDER BY amount', [a])).rows,
    [{ amount: '20.00', method: 'card' }, { amount: '60.00', method: 'cash' }]);
  assert.equal((await appt(a)).payment_status, 'paid');
});
await check('spa: a charge added after payment is what the next tap takes', async () => {
  const a = await book();
  await pay(a, { paid_with: 'cash' });
  await call(folios.addEntityAdjustment, { params: { kind: 'spa_appointment', id: a }, body: { description: 'Oil', amount: 12 } });
  assert.equal((await appt(a)).payment_status, 'unpaid');
  const pi = await call(spa.createAppointmentPaymentIntent, { params: { id: a, spa_id: spaId } });
  assert.equal(pi.body.amount, 1200);
});
await check('spa: a paid invoice settles once', async () => {
  const a = await book();
  const invoice = { id: 'in_paid', currency: 'gbp', metadata: { spa_appointment_id: a } };
  billing.invoiceLines = [{ amount: 8000, metadata: { spa_appointment_id: a } }];
  assert.deepEqual((await spa.settlePaidInvoice(fakeStripe, invoice, P)).settled, [a]);
  await spa.settlePaidInvoice(fakeStripe, invoice, P);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment WHERE spa_appointment_id = $1', [a])).rows[0].n, 1);
});
```

Export `settlePaidInvoice` from `spaPayments.js` for this check. The fake's `invoiceItems.list({ invoice })` must be async-iterable (give the returned object a `[Symbol.asyncIterator]` over `billing.invoiceLines`) because `settlePaidInvoice` uses `for await`.

- [ ] **Step 2: Run** `node -r dotenv/config scripts/check-cash-payments.js`. Expected: the three new checks FAIL, all older ones ok.
- [ ] **Step 3: Implement** the behaviour above in `spaPayments.js`. Update the comment above each changed function. Update the Swagger description of `confirm-payment` (`src/docs/swagger.js:748`): it records the amount Stripe took, sets `payment_status='paid'` only when nothing is left owing, and a retry is a 200.
- [ ] **Step 4: Run** `check-cash-payments.js`, `check-entity-folios.js`, `check-bulk-imports.js`. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Spa card, cash, invoice and bill flows charge the balance and record payments"`

---

### Task 4: Spa deposit setting; API docs and MCP

**Files:**
- Create: `src/db/migrate-2026-11-12-spa-payment-required.sql`; Modify: `src/db/schema.sql` (the `spa` table)
- Modify: `src/controllers/spa.js` (`updateSpa`)
- Modify: `src/docs/swagger.js` (`/api/spa/{id}` PUT body; the `/api/folios` kind enum gains `spa_appointment`)
- Modify: `mcp-server/tools.js` (`ENTITY_KIND` gains `'spa_appointment'`; `update_spa` gains both fields)
- Modify: `scripts/check-entity-folios.js`

**Interfaces:**
- Produces: `spa.payment_required VARCHAR(10) NOT NULL DEFAULT 'none'` with `CHECK (payment_required IN ('none','deposit','full'))`; `spa.deposit_amount NUMERIC(14,2)` with `CHECK (deposit_amount IS NULL OR deposit_amount > 0)`; constraint `spa_deposit_has_amount CHECK (payment_required <> 'deposit' OR deposit_amount IS NOT NULL)`. `PUT /api/spa/:id` accepts both (COALESCE, like the other fields). It returns 400 for an unknown mode, for a non-positive or non-numeric amount, and for `'deposit'` with no amount sent or stored. Map the constraint violation (`23514`, `spa_deposit_has_amount`) to that 400; do not pre-read the row. `GET` returns both through `SELECT *`.

- [ ] **Step 1: Write the failing check**

```js
await check('spa: payment at booking is none, deposit with an amount, or full', async () => {
  const s = await one(`INSERT INTO spa (property_id, name) VALUES ($1, 'Rules') RETURNING id, payment_required, deposit_amount`, [P]);
  assert.equal(s.payment_required, 'none'); assert.equal(s.deposit_amount, null);
  const put = (body) => call(spaCtl.updateSpa, { params: { id: s.id }, body });
  assert.equal((await put({ payment_required: 'deposit' })).status, 400);
  const ok = await put({ payment_required: 'deposit', deposit_amount: 25 });
  assert.equal(ok.status, 200); assert.equal(ok.body.deposit_amount, '25.00');
  assert.equal((await put({ payment_required: 'full' })).body.payment_required, 'full');
  assert.equal((await put({ payment_required: 'half' })).status, 400);
  assert.equal((await put({ deposit_amount: 0 })).status, 400);
  assert.equal((await put({ deposit_amount: 'abc' })).status, 400);
});
```

- [ ] **Step 2: Run** `check-entity-folios.js`. Expected: FAIL (column missing).
- [ ] **Step 3: Implement** the migration and the `schema.sql` change, then `updateSpa`, Swagger and MCP.
- [ ] **Step 4: Apply locally and run.** Run `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-11-12-spa-payment-required.sql`, then `check-entity-folios.js` and `node -r dotenv/config scripts/check-mcp-coverage.js`. Expected: all ok, exit 0.
- [ ] **Step 5: Commit** — `git commit -m "Spa setting: no payment, deposit or full payment at booking"`

---

### Task 5: hotal-ui: a Charges button in the spa feed popover

**Files (hotal-ui, in a worktree):**
- Modify: `src/LiveSpaBookingsFeed.svelte` (popover actions near line 692)
- Modify: `src/global.d.ts` or the component's event docs, wherever `send-invoice` is documented; `README.md` / `llms.txt` event lists if they list the feed's events
- Modify: `package.json` version `0.46.2`

**Interfaces:**
- Produces: a `Charges` button, always shown in the popover (cancelled and paid bookings included), that dispatches `open-charges` with `{ id, booking }` (bubbles, composed, via the existing `emit`) and closes the popover.

- [ ] **Step 1: Make the worktree.** `git -C C:\Users\robert\source\repos\hotal-ui worktree add ..\hotal-ui-spa-charges -b spa-charges HEAD` (HEAD is `80f2875`, 0.46.1). Robert's uncommitted work in the main hotal-ui tree stays untouched.
- [ ] **Step 2: Add the button and event**, following `requestBilling`.
- [ ] **Step 3: Build and pack.** Run `npm ci && npm run build && npm pack --pack-destination ..\ota-table-bookings\vendor` in the worktree. Expected: `forgebuild-hotal-ui-0.46.2.tgz` in the staff app's `vendor/`. Do not `npm publish`.
- [ ] **Step 4: Commit on `spa-charges`**: `git commit -m "live-spa-bookings-feed: Charges in the popover fires open-charges; 0.46.2"`. Leave the branch for Robert; do not merge it into hotal-ui `main`.

---

### Task 6: Staff app: Charges on spa appointments

**Files:**
- Modify: `package.json` / `package-lock.json` (`@forgebuild/hotal-ui` → `file:vendor/forgebuild-hotal-ui-0.46.2.tgz`)
- Modify: `src/scripts/charges-dialog.ts` (`ChargesKind` gains `'spa_appointment'`)
- Modify: `src/scripts/charges-block.ts` (`charged_to_booking_id`)
- Modify: `src/scripts/spa-booking-actions.ts` (`wireSpaBookingActions` listens for `open-charges`)
- Modify: `src/pages/spa-dashboard.astro` and the property dashboard page that hosts the spa feed (the page loading `dashboard-client.ts`): include `<ChargesDialog />`
- Modify: `tests/entity-charges.spec.ts`

**Interfaces:**
- Consumes: the `open-charges` event (Task 5); `openChargesDialog(kind, id, title)`.
- `fillCharges`: when the folio has `charged_to_booking_id`, the charges and Paid lines show as usual. In place of the Balance or Credit line it shows `Charged to the room booking`, with no add-charge or payment form.
- The dialog title is the booking's first and last name from the event's `booking`.

- [ ] **Step 1: Write the failing test** in `tests/entity-charges.spec.ts`: open `/spa-dashboard`, click the first appointment card, click the popover's `Charges` button, expect `#charges-dialog` visible with `.rbd-charges-totals` containing `Paid`, add a charge `Playwright oil` / `5`, see the line, remove it.
- [ ] **Step 2: Run** `npx playwright test tests/entity-charges.spec.ts`. Expected: the new test FAILS (no Charges button). The OTA API must be running locally on :3000 from the merged Tasks 1 to 4.
- [ ] **Step 3: Implement.** Run `npm install` to pick up the vendored tgz, then make the listed changes.
- [ ] **Step 4: Run** the spec and `npx astro check`. Expected: all pass, 0 errors.
- [ ] **Step 5: Commit** — `git commit -m "Charges on spa appointments, from the spa feed popover"`

---

### Task 7: Staff app: the spa's payment-at-booking setting

**Files:**
- Modify: `src/pages/spa-dashboard.astro` (the spa config sheet, beside `#spa-config-lead-time`)
- Modify: `src/scripts/spa-dashboard-client.ts` (`setupSalonDetailsSection`, `SPA_FIELD_LABELS`, the loader that fills the sheet near line 325)
- Modify: `tests/entity-charges.spec.ts`

**Interfaces:**
- `#spa-config-payment-required`, a select labelled "Payment at booking" with options `none` "No payment", `deposit` "Deposit", `full` "Full payment".
- `#spa-config-deposit-amount`, a number input labelled "Deposit amount" (`step 0.01`, `min 0.01`), shown only when the select is `deposit`.
- Saving: choosing `none` or `full` saves `{ payment_required }` (toast "Payment at booking saved"). Choosing `deposit` with an amount in the field saves `{ payment_required: 'deposit', deposit_amount }`; with an empty field it reveals and focuses the amount and saves nothing. Changing the amount saves `{ payment_required: 'deposit', deposit_amount }` (toast "Deposit amount saved").

- [ ] **Step 1: Write the failing test.** It mirrors the restaurant-settings test: open the sheet; choose Deposit and see the amount field; enter `20` and see "Deposit amount saved"; reopen and see `deposit` / `20.00`; restore the original mode in `finally`.
- [ ] **Step 2: Run** it and see it fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole spec and `npx astro check`. Expected: all pass, 0 errors.
- [ ] **Step 5: Commit** — `git commit -m "Spa settings: payment at booking and deposit amount"`

---

## After the last task

Do a final fresh review of OTA, hotal-ui `spa-charges` and the staff app together. Robert's shipping order:

1. Run both migrations on the live DB, with his OK: the backfill, then the payment-required migration.
2. Push OTA `main`.
3. Publish hotal-ui 0.46.2, or re-vendor whatever he publishes.
4. Deploy the staff app.

If the staff app ships before step 2, it shows "Could not load charges" on spa appointments.
