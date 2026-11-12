# Entity Charges, Plan 3 of 3: amount due now, website payments, enforcement

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OTA tells a website what a golf booking, equipment hire, restaurant reservation or spa appointment needs paid at booking. A booking from a website key must carry that payment, which OTA records in the same step. A website can also record what it took for a room. Staff, scripts and every other key keep booking unpaid.

**Architecture:**
- A new `api_key.website` flag marks the keys whose bookings are enforced. The flag reaches every request as `req.api_key.website`.
- One module, `src/lib/amountDue.js`, does three things:
  - prices a prospective booking of each kind with the venue's rule (`dueNow`);
  - checks a website key's stated payment against that (`checkStatedPayment`);
  - writes the payment row inside the create transaction (`recordStatedPayment`).
- The four create controllers call it, and so does a read-only route, `GET /api/folios/due-now/:kind`.
- Golf courses and equipment items gain a `payment_required` rule (none or full). Restaurants (plan 1) and spas (plan 2) already have theirs.

**Tech Stack:** Node 22 / Express / PostgreSQL (`pg`), check scripts with `node:assert/strict` and `scripts/fake-stripe.js`, MCP tools in `mcp-server/tools.js`; the staff app is Astro + TypeScript with Playwright.

**Spec:** `C:\Users\robert\source\repos\OTA\docs\superpowers\specs\2026-11-12-entity-charges-design.md` (read "Deposit rules", "Enforcement", and the "Website payments are records" rule). Plans 1 and 2 are next to this file.

**Two repositories.** Tasks 1 to 6 are in `C:\Users\robert\source\repos\OTA`. Task 7 is in `C:\Users\robert\source\repos\ota-table-bookings`. Paths are relative to the task's repository. The Hamilton site's stay cart, which calls all of this, is a separate plan in the hamilton-island repo.

## Decisions

- **Who is enforced (Robert, 2026-11-12):** only requests made with an API key flagged `website`. Staff (Clerk bearer) and every key without the flag, full or scoped, are exempt, as are imports and edits to an existing booking. The admin sets the flag on Hamilton's key.
- **Scoped keys are exempt too (call).** The spec named only staff and full keys as exempt, but enforcing scoped keys would break other sites' widgets the day a venue switches a rule on, and those widgets have no way to pay yet.
- **A website key is trusted for what it states (call).** It says how much it took and the Stripe id; OTA records that and does not call Stripe. The site charged on its own account, which OTA cannot see, the same trust `payment_verified` already gets on spa bookings. The spec's "check it with Stripe when the intent is on the property's own account" has no caller today and is left out.
- **Only a website key may state a payment.** Any other caller sending `payment` gets 403, so nothing else can create a Paid line by claiming one.
- **Shape.** A create request may carry `payment: { amount, stripe_payment_intent_id }` (amount > 0, a reference of 1 to 255 characters). It is recorded as `method 'website'`, `status 'completed'`, `paid_at now()`, on the booking's owner column, in the same transaction as the booking. An amount above what is due is recorded as stated.
- **Refused booking.** HTTP 402, body `{ error: 'Payment required', mode, amount_due, currency }`. `amount_due` is a two-decimal string. Nothing is written.
- **Spa.** A stated payment above zero counts as `payment_verified`, so a paid website booking is confirmed at once instead of waiting on the emailed link.
- **`hold` restaurants** answer `mode 'hold', due_now '0.00'` and are not enforced; their card hold works as today.
- **Room payments from a website** use the existing `POST /api/payments`, which gains `stripe_payment_intent_id`. A room cancel refunds only `method = 'card'` rows (`src/lib/roomPayments.js:350`), so `method 'website'` rows are never sent to Stripe. No change is needed there; Task 6 pins it with a check.

## Global Constraints

- Everything in plan 1's Global Constraints still holds: property scoping (another property's row is a 404), money as two-decimal strings summed in cents with `toCents` / `fromCents`, dated migration plus the same change in `schema.sql`, Swagger + MCP + `check-mcp-coverage.js` for API changes, no commits pushed.
- **Never run a migration against the live database.** Always `DATABASE_URL_LIVE= node scripts/run-migration.js <file>`. Live migration and the push are Robert's, with his OK.
- Every rule defaults to "nothing required", so no property's behaviour changes until a rule is switched on **and** a key is flagged `website`.
- The price `dueNow` uses for a kind is computed exactly as that kind's create path computes the stored price. Where both exist, the controller uses `dueNow`'s figure, not a second calculation.
- Rule values, exactly:
  - `golf_course.payment_required` and `equipment.payment_required`: `'none' | 'full'`, default `'none'`.
  - Spa (`'none' | 'deposit' | 'full'`, with `deposit_amount`) and restaurant (`payment_protection`, `payment_protection_amount`, `payment_protection_basis`) are unchanged.
- `dueNow` modes: `'none' | 'deposit' | 'full' | 'hold'`.
  - A spa deposit is capped at the appointment's price.
  - A restaurant deposit is `amount × party_size` when `per_guest`, otherwise `amount`.

## Review Focus

1. **A website key booking a venue whose rule is off.** It must book exactly as today, with no `payment` needed. If it sends one anyway, the payment is recorded. Test in Task 4.
2. **A refused booking leaves nothing behind**: no booking row, no payment row, and for spa no pending hold. Test in Tasks 4 and 5.
3. **A spa deposit larger than the treatment's price** (deposit 50, member price 30): only 30 is due. Test in Task 3.
4. **A website key on a `hold` restaurant with no `payment`**: booked as today, not 402. Test in Task 5.
5. **An org-level website key** (`authenticateOrgKey`, `resolveSiteProperty` org path): it carries `website` the same as a property key. Test in Task 1.

---

### Task 1: Website keys

**Files:**
- Create: `src/db/migrate-2026-11-12-website-keys.sql`; Modify: `src/db/schema.sql` (the `api_key` table, line 128)
- Modify: `src/lib/apiKeys.js` (`COLS`, `create`, whatever `update` accepts), `src/controllers/apiKeys.js` (`parseBody`), `src/lib/propertyResolver.js:60`, `src/middleware/auth.js:161`
- Modify: `src/docs/swagger.js` (the `/api/property/api-keys` and org `/api-keys` bodies and rows)
- Create: `scripts/check-website-payments.js` (harness as in `scripts/check-cash-payments.js`, with `fake-stripe` installed the same way, a throwaway property, cleanup in `finally`)
- Modify: the spec, replacing the "Unresolved; raise with Robert" paragraph in "Enforcement" with Robert's answer and the Decisions above

**Interfaces:**
- Produces: `api_key.website BOOLEAN NOT NULL DEFAULT false`. Key rows (list, create, update) include `website`. `PUT`/`POST` `.../api-keys` accept `website` (boolean, else 400 `'website must be a boolean'`).
- Produces: `req.api_key = { id, permissions, website }` on every API-key request. Later tasks test `req.api_key?.website === true`.
- Produces: the check-script harness for later tasks: `P`, `one`, `call(fn, req)`, `check`, and the request decorators `websiteKey = { auth_method: 'api_key', api_key: { id: null, permissions: null, website: true } }`, `fullKey` (same, `website: false`) and `staff` (bearer, role `'staff'`).

- [ ] **Step 1: Write the failing checks**

```js
await check('keys: website flag defaults off, can be set, reaches the request', async () => {
  const k = await apiKeys.create(pool, { property_id: P }, { name: 'Site' });
  assert.equal(k.website, false);
  const put = await call(keysCtl.property.update, { params: { id: k.id }, body: { website: true } });
  assert.equal(put.status, 200); assert.equal(put.body.website, true);
  assert.equal((await call(keysCtl.property.update, { params: { id: k.id }, body: { website: 'yes' } })).status, 400);
  assert.equal((await resolveSiteProperty(pool, { key: k.key })).apiKey.website, true);
});
await check('keys: an org key carries website too', async () => {
  // org with one active property P (set property.clerk_org_id for the throwaway org)
  const k = await apiKeys.create(pool, { clerk_org_id: ORG }, { name: 'Group site' });
  await apiKeys.update(pool, { clerk_org_id: ORG }, k.id, { website: true });
  assert.equal((await resolveSiteProperty(pool, { key: k.key })).apiKey.website, true);
});
```

- [ ] **Step 2: Run** `node -r dotenv/config scripts/check-website-payments.js`. Expected: FAIL (`website` undefined).
- [ ] **Step 3: Implement** as in Interfaces. The migration is `ALTER TABLE api_key ADD COLUMN IF NOT EXISTS website BOOLEAN NOT NULL DEFAULT false;`.
- [ ] **Step 4: Apply locally and run.** Run `DATABASE_URL_LIVE= node scripts/run-migration.js src/db/migrate-2026-11-12-website-keys.sql`, then the check script. Expected: all ok. `scripts/check-mcp-coverage.js` exits 0.
- [ ] **Step 5: Commit** — `git commit -m "API keys can be marked website: their bookings will carry payment"`

---

### Task 2: Golf course and equipment payment rules

**Files:**
- Create: `src/db/migrate-2026-11-12-golf-equipment-payment-required.sql`; Modify: `src/db/schema.sql` (`golf_course`, `equipment`)
- Modify: `src/controllers/golf.js` (`createCourse`, `updateCourse`), `src/controllers/equipment.js` (`createEquipment`, `updateEquipment`)
- Modify: `src/docs/swagger.js`, `mcp-server/tools.js` (`create_golf_course`, `update_golf_course`, `create_equipment`, `update_equipment`)
- Modify: `scripts/check-website-payments.js`

**Interfaces:**
- Produces: `golf_course.payment_required` and `equipment.payment_required`, each `VARCHAR(10) NOT NULL DEFAULT 'none'` with a CHECK of `IN ('none', 'full')`. Accepted on create and update (COALESCE on update). Any other value is 400 `'payment_required must be none or full'`.

- [ ] **Step 1: Write the failing check**: a new course and a new equipment item default to `'none'`; update to `'full'` returns `'full'`; an update of another field keeps it; `'deposit'` and `5` are 400, on both create and update.
- [ ] **Step 2: Run** the script. Expected: FAIL.
- [ ] **Step 3: Implement**, apply the migration locally (as in Task 1), Swagger, MCP.
- [ ] **Step 4: Run** the script and `check-mcp-coverage.js`. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Golf courses and equipment: no payment or full payment at booking"`

---

### Task 3: The amount due now

**Files:**
- Create: `src/lib/amountDue.js`
- Modify: `src/routes/folios.js`, `src/controllers/entityFolio.js` (a `getDueNow` handler)
- Modify: `src/docs/swagger.js`, `mcp-server/tools.js` (tool `get_amount_due_now`)
- Modify: `scripts/check-website-payments.js`

**Interfaces:**
- Produces: `dueNow(db, kind, propertyId, params) -> Promise<{ mode, price, due_now, currency } | { status, error }>`.
  - `price` and `due_now` are two-decimal strings; `price` is `null` for a restaurant.
  - `{ status, error }` is 400 for missing or invalid params and 404 for a venue not in the property.
- `params` per kind, as the create bodies name them:

| kind | params | price |
|---|---|---|
| `golf_booking` | `tee_time_id`, `players` | course `price_per_player × players` |
| `equipment_hire` | `equipment_id`, `quantity`, `rate_type` (default `per_day`), `duration` (default 1) | `price_per_day` or `price_per_hour` (null counts as 0) × quantity × duration |
| `restaurant_reservation` | `restaurant_id`, `party_size` | none |
| `spa_appointment` | `spa_id`, `treatment_id`, `date`, optional `member_email` | `resolveRate(treatment, await memberRateUntil(db, propertyId, member_email), date).price` (`src/lib/spaMemberRate.js`); a `rate.ok === false` is 409 with `rate.code` as the error |

  Validation and rounding match the create paths (`createBooking` in `golf.js`, `createHire` in `equipment.js`).
- Currency is the property's, except a restaurant's, which is `COALESCE(restaurant.currency, property.currency)`.
- Produces: `GET /api/folios/due-now/:kind?<params>`, behind the folios router's staff-or-full-key guard, registered **before** `/:kind/:id`. It responds 200 with the `dueNow` result or `status` / `{ error }`. An unknown kind is 404.

- [ ] **Step 1: Write the failing checks**, one `check` per row, each asserting `{ mode, due_now }` (and `price` where there is one):
  - golf `full`, 2 players at 90.00 → `full`, `180.00`; the same course set to `none` → `none`, `0.00`, price `180.00`.
  - hire `full`, 2 × per_day 25.00 × 3 → `75.00 × 2` = `150.00`.
  - restaurant `deposit` 20.00 `per_guest`, party 4 → `deposit`, `80.00`; `per_table` → `20.00`; `hold` → `hold`, `0.00`; `none` → `none`, `0.00`.
  - spa `deposit` 50 with a treatment priced 30 → `deposit`, `30.00` (capped, Review Focus 3); `deposit` 20 on 30 → `20.00`; `full` → `30.00`.
  - errors: another property's tee time → 404; `players: 0` → 400; unknown kind on the route → 404; the route returns the same object as `dueNow` for one golf case.
- [ ] **Step 2: Run** the script. Expected: the new checks FAIL (module missing).
- [ ] **Step 3: Implement** `amountDue.js` (`dueNow` only in this task), the handler, the route, Swagger and the MCP tool.
- [ ] **Step 4: Run** the script and `check-mcp-coverage.js`. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Amount due now for golf, hire, restaurant and spa bookings"`

---

### Task 4: Enforcement on golf bookings and equipment hires

**Files:**
- Modify: `src/lib/amountDue.js`, `src/controllers/golf.js` (`createBooking`), `src/controllers/equipment.js` (`createHire`)
- Modify: `src/docs/swagger.js` (the two create bodies gain `payment`; the 402 and 403 responses), `mcp-server/tools.js` (`create_golf_booking`, `create_equipment_hire` gain optional `payment`)
- Modify: `scripts/check-website-payments.js`

**Interfaces:**
- Produces, in `amountDue.js`:
  - `checkStatedPayment(req, due) -> { status, body } | null`. Rules:
    - `req.body.payment` present from a caller without `req.api_key?.website` → `{ status: 403, body: { error: 'Only a website API key can state a payment' } }`.
    - A malformed `payment` → 400.
    - A website key, `due.mode` in `deposit`/`full`, `due_now > 0`, and a stated amount (or none) below `due_now` → the 402 body from Decisions.
    - Otherwise `null`.
  - `recordStatedPayment(client, kind, id, propertyId, payment) -> Promise<void>` inserts the payment row from Decisions (no-op when `payment` is absent).
- Both controllers call `dueNow(client, …)` inside their transaction, after the venue row is read (and locked, for hire) and before the INSERT. On a check result they `ROLLBACK` and respond with it. After the INSERT they call `recordStatedPayment` before `COMMIT`. `createBooking` takes its `total_price` from `dueNow`'s `price`.

- [ ] **Step 1: Write the failing checks** (course and item set to `full`):

```js
await check('golf: a website key must pay; a short or missing payment books nothing', async () => {
  const before = await count('golf_booking');
  const none = await call(golf.createBooking, { ...websiteKey, body: { tee_time_id: tt, contact_name: 'W', players: 2 } });
  assert.equal(none.status, 402); assert.deepEqual(none.body, { error: 'Payment required', mode: 'full', amount_due: '180.00', currency: 'GBP' });
  const short = await call(golf.createBooking, { ...websiteKey, body: { tee_time_id: tt, contact_name: 'W', players: 2, payment: { amount: 100, stripe_payment_intent_id: 'pi_site_1' } } });
  assert.equal(short.status, 402);
  assert.equal(await count('golf_booking'), before);
  const ok = await call(golf.createBooking, { ...websiteKey, body: { tee_time_id: tt, contact_name: 'W', players: 2, payment: { amount: 180, stripe_payment_intent_id: 'pi_site_2' } } });
  assert.equal(ok.status, 201);
  assert.deepEqual(await one('SELECT amount, method, status, stripe_payment_intent_id FROM payment WHERE golf_booking_id = $1', [ok.body.id]),
    { amount: '180.00', method: 'website', status: 'completed', stripe_payment_intent_id: 'pi_site_2' });
  assert.equal((await computeEntityFolio('golf_booking', ok.body.id, P)).balance, '0.00');
});
await check('golf: staff and other keys are exempt; only a website key may state a payment', async () => {
  assert.equal((await call(golf.createBooking, { ...staff, body: { tee_time_id: tt, contact_name: 'S', players: 1 } })).status, 201);
  assert.equal((await call(golf.createBooking, { ...fullKey, body: { tee_time_id: tt, contact_name: 'F', players: 1 } })).status, 201);
  assert.equal((await call(golf.createBooking, { ...fullKey, body: { tee_time_id: tt, contact_name: 'F', players: 1, payment: { amount: 90, stripe_payment_intent_id: 'pi_x' } } })).status, 403);
});
await check('golf: a rule that is off books a website key as today, and records a payment it sends', async () => { /* course 'none': no payment -> 201; payment 10 -> 201 + one website row */ });
await check('hire: a website key must pay the full hire', async () => { /* 402 with amount_due '150.00', then 201 with a 'website' row on equipment_hire_id */ });
```

Include the `payment` shape cases: `{ amount: 0 }`, `{ amount: 'x' }` and a missing `stripe_payment_intent_id` are each 400.

- [ ] **Step 2: Run** the script. Expected: the new checks FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the script, `check-entity-folios.js` and `check-mcp-coverage.js`. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Website-key golf bookings and hires carry their payment, recorded in the same step"`

---

### Task 5: Enforcement on restaurant reservations and spa appointments

**Files:**
- Modify: `src/controllers/restaurant.js` (`createReservation`), `src/controllers/spa.js` (`createAppointmentFromSlot`, `bookFromAvailability`, `createAppointmentFromAvailability`)
- Modify: `src/docs/swagger.js`, `mcp-server/tools.js` (`create_restaurant_reservation`, `create_spa_appointment` gain optional `payment`)
- Modify: `scripts/check-website-payments.js`

**Interfaces:**
- Consumes: `dueNow`, `checkStatedPayment`, `recordStatedPayment` (Tasks 3 and 4).
- `bookFromAvailability` gains options `statedPayment = null` and `enforcePayment = false`; `createAppointmentFromAvailability` passes `req.body.payment` and `req.api_key?.website === true`. Voice and the AI reply pipeline pass neither, so they are exempt.
- A refusal inside `bookFromAvailability` returns `{ ok: false, code: 'payment_required', due }`. The route maps it to the 402 body.
- A stated payment with an amount above 0 sets `payment_verified`.
- Spa `dueNow` uses the same `resolveRate` result the INSERT freezes.
- The 403 for a non-website `payment` and the 400 for a malformed one come before any lock, as in Task 4.

- [ ] **Step 1: Write the failing checks**:
  - restaurant `deposit` 20 `per_guest`, party 3: no payment → 402 `'60.00'`; payment 60 → 201 with a `website` row on `restaurant_reservation_id`.
  - restaurant `hold`, no payment → 201 (Review Focus 4).
  - spa `deposit` 20, guest-rail website key, availability path: no payment → 402 and no `spa_appointment` row, pending or otherwise (Review Focus 2); payment 20 → 201 with `status` `'confirmed'` (not pending), a `website` row on `spa_appointment_id`, and a folio balance of price minus 20.
  - spa slot path with the same rule: no payment → 402.
  - `fullKey` and `staff` on both kinds with the rules on → 201 without payment.
- [ ] **Step 2: Run** the script. Expected: the new checks FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the script, `check-cash-payments.js`, `check-entity-folios.js`, `check-bulk-imports.js` and `check-mcp-coverage.js`. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Website-key reservations and spa appointments carry their payment, recorded in the same step"`

---

### Task 6: Website payments on rooms

**Files:**
- Modify: `src/controllers/payments.js` (`createPayment`), `src/docs/swagger.js` (`POST /api/payments`), `mcp-server/tools.js` (`record_payment`)
- Modify: `scripts/check-website-payments.js`

**Interfaces:**
- `POST /api/payments` accepts an optional `stripe_payment_intent_id` (string, 1 to 255 characters, else 400) and stores it. Nothing else changes. Several bookings may record the same id.

- [ ] **Step 1: Write the failing checks**:
  - A payment with `method: 'website'`, `status: 'completed'` and `stripe_payment_intent_id: 'pi_cart'` is stored with that id.
  - Two bookings record the same `pi_cart`, and both succeed.
  - `roomPayments.stripeForCancel(<the booking row>, { refund: true, keepIntent: false })` leaves fake Stripe with no refund for `pi_cart`.
  - `stripe_payment_intent_id: 5` is 400.
- [ ] **Step 2: Run** the script. Expected: the storing check FAILS. The refund check passes already (no change needed, see Decisions); keep it as the pin.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the script, `check-multi-room-bookings.js`, `check-mcp-coverage.js`. Expected: all ok.
- [ ] **Step 5: Commit** — `git commit -m "Room payments can carry the website's Stripe id"`

---

### Task 7: Staff app: website keys and golf / equipment rules

**Files:**
- Modify: `src/pages/settings.astro` (the API keys table header, line 420), `src/scripts/settings-client.ts` (`ApiKey`, `renderApiKeys`, the change handler)
- Modify: `src/scripts/golf-client.ts` and `src/scripts/equipment-client.ts` (row markup, field labels, autosave), and the pages' table headers
- Create: `tests/payment-rules.spec.ts`

**Interfaces:**
- The API keys table gains a `Website` column after `Full access`: a checkbox `data-field="website"` that saves `{ website }`.
- Golf courses and equipment rows gain a `Payment at booking` select (`data-field="payment_required"`, options `none` "No payment", `full` "Full payment"). It saves `{ payment_required }` with that field's toast label.

- [ ] **Step 1: Write the failing tests.** Each changes a value, reloads, sees it kept, and puts the original back in `finally`:
  - settings: tick `Website` on the first key.
  - golf: set the first course's select to `full`.
  - equipment: set the first item's select to `full`.
- [ ] **Step 2: Run** `npx playwright test tests/payment-rules.spec.ts` with the merged OTA API on :3000. Expected: FAIL (controls missing).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the spec, `tests/entity-charges.spec.ts` and `npx astro check`. Expected: all pass, 0 errors.
- [ ] **Step 5: Commit** — `git commit -m "Settings: website API keys; golf and equipment payment at booking"`

---

## After the last task

Do a final fresh review of both repositories. Robert's shipping order:

1. Live migrations, with his OK: website keys, then golf and equipment rules.
2. Push OTA `main`.
3. Deploy the staff app.

Nothing changes for any site until an admin ticks `Website` on a key **and** a venue's rule is switched on. For Hamilton, that waits for the stay cart and the separate golf, spa and restaurant pages to send `payment` (the spec's operational step).
