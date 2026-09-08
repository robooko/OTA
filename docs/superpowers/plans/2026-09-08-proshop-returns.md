# Pro-shop Returns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guest (via the venue website) or staff (via the dashboard) request a return of some items from a paid shop order; OTA tracks the return with its own status and manages the conversation as an enquiry thread, guaranteeing the guest a first reply.

**Architecture:** Two new tables (`proshop_return`, `proshop_return_item`) plus an order `reference` and a property `return_instructions` column in OTA. Creating a return also creates an `event_inquiry` (type `Return order items`) in the same transaction, so the existing enquiry feed, reply dialog, and AI reply pipeline carry the thread. The dashboard reply dialog gains a return panel with a status control; the Orders dialog gains a Reference column and a staff "Return" action; Settings gains a Returns tab.

**Tech Stack:** OTA: Node 20 / Express / `pg` / Resend / Ably / Anthropic SDK (no test framework — verification is manual against the local server). Dashboard (`ota-table-bookings`): Astro + TypeScript, `@forgebuild/hotal-ui` web components (unchanged by this plan).

**Spec:** `OTA/docs/superpowers/specs/2026-09-08-proshop-returns-design.md`

## Global Constraints

- Two repos: `C:\Users\robert\source\repos\OTA` (backend) and `C:\Users\robert\source\repos\ota-table-bookings` (dashboard). Each task says which.
- OTA's `main` auto-deploys to Render on push. **Task 1 must apply the migration to BOTH databases (`DATABASE_URL` and `DATABASE_URL_LIVE`, via `node scripts/run-migration.js`) before its commit is pushed.** Every OTA task ends with `git push` because each leaves the API consistent.
- Return statuses: `requested`, `approved`, `rejected`, `received`, `refunded`, `cancelled`. Transitions: `requested → approved | rejected | cancelled`; `approved → received | cancelled`; `received → refunded | cancelled`; `refunded`, `rejected`, `cancelled` are terminal.
- Enquiry type literal for returns: `Return order items` (exact string, used by the feed badge and the AI prompt).
- Order reference: 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique per property.
- No Clerk link on orders. Guest identification is order reference + email on the order. Only orders with `payment_status = 'paid'` and `status <> 'cancelled'` are returnable.
- No refunds are automated. No emails on status changes. Exactly one first reply per return (AI auto-send, or the fallback acknowledgement).
- Neither repo has automated tests. Each task ends with the exact manual check to run and the expected output. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Local servers: OTA on `http://localhost:3000` (`node src/server.js`, no auto-reload — restart after code changes); dashboard on `http://localhost:4335` (`astro dev --background`; `.env` points `PUBLIC_OTA_API_BASE_URL` at the local OTA). Dashboard sign-in: `ota-dashboard-test+clerk_test@example.com`.
- For curl checks set `OTA_KEY` to the local property's API key. Get it with:
  ```bash
  cd /c/Users/robert/source/repos/OTA && node -e "require('dotenv').config();const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query(\"SELECT id, name, api_key FROM property WHERE api_key_enabled ORDER BY name\");console.table(r.rows);await c.end();})()"
  ```

---

## File map

**OTA (create):**
- `src/db/migrate-2026-09-08-proshop-returns.sql` — schema change + backfill.
- `src/lib/orderReference.js` — reference generator/normaliser.
- `src/lib/proshopReturns.js` — return status table, DB loaders, message builder, `ensureFirstReply`.

**OTA (modify):**
- `src/db/schema.sql` — mirror the migration.
- `src/controllers/proshop.js` — reference on create; lookup, returns CRUD.
- `src/routes/proshop.js` — new routes.
- `src/controllers/property.js` — `return_instructions` on `/api/property/me`.
- `src/controllers/eventInquiries.js` — embed `return` on list.
- `src/lib/inquiryReplies.js` — select `return_instructions`; split out `recordOutboundReply`.
- `src/lib/aiReplyPipeline.js` — load the return for the prompt; never store a booking proposal for a return.
- `src/lib/aiReplies.js` — prompt blocks.
- `src/lib/resend.js` — `sendReturnAcknowledgement`.
- `src/lib/ably.js` — `publishProshopReturnStatusChanged`.
- `src/docs/swagger.js` — new endpoints and fields.
- `mcp-server/tools.js` — four tools.

**Dashboard (modify):**
- `src/scripts/event-inquiry-dialogs.ts` — return panel in the reply dialog.
- `src/styles/global.css` — status colours for the return badge.
- `src/pages/pro-shop.astro`, `src/scripts/shop-client.ts` — Reference column, Return action, return dialog.
- `src/pages/settings.astro`, `src/scripts/settings-client.ts` — Returns tab.

---

### Task 1: Migration, schema mirror, order reference (OTA)

**Files:**
- Create: `src/db/migrate-2026-09-08-proshop-returns.sql`
- Create: `src/lib/orderReference.js`
- Modify: `src/db/schema.sql` (the `proshop_order` block at ~845, indexes at ~890, `property` block near line 39)
- Modify: `src/controllers/proshop.js` (`createOrder`, ~331-408)

**Interfaces:**
- Produces: `generateOrderReference(): string`, `normaliseReference(value): string` from `src/lib/orderReference.js`. Column `proshop_order.reference`. Tables `proshop_return`, `proshop_return_item`. Column `property.return_instructions`.

- [ ] **Step 1: Write the migration**

`src/db/migrate-2026-09-08-proshop-returns.sql`:

```sql
-- One-time migration: pro-shop returns (design: docs/superpowers/specs/
-- 2026-09-08-proshop-returns-design.md). Run ONCE against an already-
-- populated database via scripts/run-migration.js (both DATABASE_URL and
-- DATABASE_URL_LIVE). Idempotent.

-- Short human-readable order code guests type into a return form. Backfilled
-- for existing orders below before NOT NULL is applied.
ALTER TABLE proshop_order ADD COLUMN IF NOT EXISTS reference VARCHAR(12);

DO $$
DECLARE
  r RECORD;
  ref TEXT;
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
  FOR r IN SELECT id, property_id FROM proshop_order WHERE reference IS NULL LOOP
    LOOP
      ref := '';
      FOR i IN 1..6 LOOP
        ref := ref || substr(alphabet, floor(random() * 32)::int + 1, 1);
      END LOOP;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM proshop_order WHERE property_id = r.property_id AND reference = ref);
    END LOOP;
    UPDATE proshop_order SET reference = ref WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE proshop_order ALTER COLUMN reference SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proshop_order_reference ON proshop_order(property_id, reference);

-- Free text sent to guests when they request a return and fed to AI replies.
ALTER TABLE property ADD COLUMN IF NOT EXISTS return_instructions TEXT;

CREATE TABLE IF NOT EXISTS proshop_return (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID        NOT NULL REFERENCES property(id),
  order_id         UUID        NOT NULL REFERENCES proshop_order(id),
  event_inquiry_id UUID        NOT NULL REFERENCES event_inquiry(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'requested',
  reason           TEXT,
  raised_by        VARCHAR(10) NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT proshop_return_status_check CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled')),
  CONSTRAINT proshop_return_raised_by_check CHECK (raised_by IN ('guest', 'staff'))
);

CREATE TABLE IF NOT EXISTS proshop_return_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     UUID NOT NULL REFERENCES proshop_return(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES proshop_order_item(id),
  quantity      INT  NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_proshop_return_property    ON proshop_return(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_order       ON proshop_return(order_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_inquiry     ON proshop_return(event_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_item_return ON proshop_return_item(return_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_item_line   ON proshop_return_item(order_item_id);
```

- [ ] **Step 2: Mirror in `schema.sql`**

In the `proshop_order` CREATE TABLE, add after `shop_id`:

```sql
  -- Short code guests quote for returns -- see migrate-2026-09-08-proshop-returns.sql
  reference                VARCHAR(12)   NOT NULL,
```

After `CREATE INDEX IF NOT EXISTS idx_proshop_order_item ...` add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_proshop_order_reference     ON proshop_order(property_id, reference);
```

In the `property` CREATE TABLE, after the `fallback_email` line, add:

```sql
  return_instructions TEXT, -- sent to guests requesting a shop return; also fed to AI replies
```

After the `event_inquiry_message` block (so both referenced tables exist first), add a new section:

```sql
-- ── Pro Shop Returns ──────────────────────────────────────────────────────────
-- A return is its own record (status flow below) and always opens an
-- event_inquiry thread, which is where staff manage it -- see
-- docs/superpowers/specs/2026-09-08-proshop-returns-design.md.

CREATE TABLE IF NOT EXISTS proshop_return (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID        NOT NULL REFERENCES property(id),
  order_id         UUID        NOT NULL REFERENCES proshop_order(id),
  event_inquiry_id UUID        NOT NULL REFERENCES event_inquiry(id),
  status           VARCHAR(20) NOT NULL DEFAULT 'requested',
  reason           TEXT,
  raised_by        VARCHAR(10) NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT proshop_return_status_check CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled')),
  CONSTRAINT proshop_return_raised_by_check CHECK (raised_by IN ('guest', 'staff'))
);

CREATE TABLE IF NOT EXISTS proshop_return_item (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id     UUID NOT NULL REFERENCES proshop_return(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES proshop_order_item(id),
  quantity      INT  NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_proshop_return_property    ON proshop_return(property_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_order       ON proshop_return(order_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_inquiry     ON proshop_return(event_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_item_return ON proshop_return_item(return_id);
CREATE INDEX IF NOT EXISTS idx_proshop_return_item_line   ON proshop_return_item(order_item_id);
```

- [ ] **Step 3: Reference generator**

`src/lib/orderReference.js`:

```js
const crypto = require('crypto');

// No 0/O/1/I: guests read these off a confirmation email and type them into
// a return form, so ambiguous glyphs are left out. 32^6 ≈ 1.07 billion codes
// per property -- collisions are checked for anyway (createOrder).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 6;

function generateOrderReference() {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// What a guest typed -> what's stored: trimmed, upper-cased. Never throws.
function normaliseReference(value) {
  return String(value ?? '').trim().toUpperCase();
}

module.exports = { generateOrderReference, normaliseReference };
```

- [ ] **Step 4: Generate the reference in `createOrder`**

At the top of `src/controllers/proshop.js` add:

```js
const { generateOrderReference } = require('../lib/orderReference');
```

Inside `createOrder`, immediately before the `INSERT INTO proshop_order` (after `const totalPrice = ...`), add:

```js
      // Unique per property; the existence check runs inside the transaction
      // so a collision (vanishingly rare at 32^6) is retried instead of
      // aborting the transaction on the unique index.
      let reference;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateOrderReference();
        const { rows: clash } = await client.query(
          'SELECT 1 FROM proshop_order WHERE property_id = $1 AND reference = $2', [req.property_id, candidate]
        );
        if (!clash.length) { reference = candidate; break; }
      }
      if (!reference) throw new Error('Could not allocate an order reference');
```

Change the INSERT to:

```js
      const { rows: orderRows } = await client.query(
        `INSERT INTO proshop_order
           (property_id, shop_id, reference, contact_name, contact_email, contact_phone, shipping_address, shipping_cost, items_subtotal, tax_amount, total_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [req.property_id, shop_id, reference, contact_name || 'Website Guest', contact_email || null, contact_phone || null, shipping_address || null, shippingCost, itemsSubtotal, taxAmount, totalPrice, notes || null]
      );
```

- [ ] **Step 5: Apply the migration to both databases**

```bash
cd /c/Users/robert/source/repos/OTA && node scripts/run-migration.js src/db/migrate-2026-09-08-proshop-returns.sql
```

Expected: `DATABASE_URL: ok` and `DATABASE_URL_LIVE: ok`. If `DATABASE_URL_LIVE: not set, skipped` appears, stop and get the live URL into `.env` before continuing — the code in this task must not reach Render before the live column exists.

- [ ] **Step 6: Verify**

```bash
cd /c/Users/robert/source/repos/OTA && node -e "require('dotenv').config();const {Client}=require('pg');(async()=>{for(const k of ['DATABASE_URL','DATABASE_URL_LIVE']){const c=new Client({connectionString:process.env[k],ssl:/localhost/.test(process.env[k])?false:{rejectUnauthorized:false}});await c.connect();const r=await c.query(\"SELECT count(*)::int AS orders, count(reference)::int AS with_ref, count(DISTINCT reference)::int AS distinct_ref FROM proshop_order\");const t=await c.query(\"SELECT to_regclass('proshop_return') AS r, to_regclass('proshop_return_item') AS ri\");console.log(k, r.rows[0], t.rows[0]);await c.end();}})()"
```

Expected per DB: `orders === with_ref === distinct_ref` (or all zero), and `r: 'proshop_return', ri: 'proshop_return_item'`.

Restart the local server, then create an order and confirm the response carries `reference`:

```bash
curl -s -X POST http://localhost:3000/api/proshop/orders -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d "{\"shop_id\":\"<a shop id from GET /api/proshop/shops>\",\"contact_name\":\"Ref Test\",\"contact_email\":\"ref@example.com\",\"items\":[{\"item_id\":\"<an item id from GET /api/proshop/items>\",\"quantity\":1}]}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(o.reference, /^[A-HJ-NP-Z2-9]{6}$/.test(o.reference))})"
```

Expected: a six-character code and `true`.

- [ ] **Step 7: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/db/migrate-2026-09-08-proshop-returns.sql src/db/schema.sql src/lib/orderReference.js src/controllers/proshop.js && git commit -m "Add pro-shop return tables, order references, and return instructions

Migration applied to local and live before this push.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 2: Returns library and Ably publisher (OTA)

**Files:**
- Create: `src/lib/proshopReturns.js`
- Modify: `src/lib/ably.js` (after `publishProshopOrderStatusChanged`, ~line 274, and the exports block)

**Interfaces:**
- Produces from `src/lib/proshopReturns.js`: `RETURN_STATUSES`, `RETURN_TRANSITIONS`, `RETURN_EVENT_TYPE`, `findOrderByReferenceAndEmail(propertyId, reference, email, client = pool, { lock = false } = {})`, `loadOrderLinesWithReturnable(orderId, client = pool)`, `loadReturnItems(returnIds) → Map<returnId, item[]>`, `loadReturn(returnId, propertyId)`, `loadReturnForInquiry(inquiryId)`, `buildReturnMessage(reference, lines, reason)`. (`ensureFirstReply` is added in Task 6.)
- Produces from `src/lib/ably.js`: `publishProshopReturnStatusChanged(propertyId, payload)`.

- [ ] **Step 1: Write the library**

`src/lib/proshopReturns.js`:

```js
// Pro-shop returns: the status machine, the DB loaders shared by the
// proshop controller, the enquiry list and the AI pipeline, and the
// generated enquiry message. Design: docs/superpowers/specs/
// 2026-09-08-proshop-returns-design.md.
const pool = require('../db');
const { normaliseReference } = require('./orderReference');

const RETURN_STATUSES = ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled'];

// from -> allowed next states. Terminal states have no exits; refunds are
// manual in Stripe, 'refunded' just records that it happened.
const RETURN_TRANSITIONS = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['received', 'cancelled'],
  received: ['refunded', 'cancelled'],
  refunded: [],
  rejected: [],
  cancelled: [],
};

// event_inquiry.event_type for return threads -- the feeds show it as a
// badge and the AI prompt keys off it, so it's a fixed literal.
const RETURN_EVENT_TYPE = 'Return order items';

// The guest-facing identity of an order: reference + the email on it. A
// mismatch on either half is the same 404 to the caller (no hint which).
// Only paid, uncancelled orders resolve -- nothing else is returnable.
async function findOrderByReferenceAndEmail(propertyId, reference, email, client = pool, { lock = false } = {}) {
  const ref = normaliseReference(reference);
  const mail = String(email ?? '').trim().toLowerCase();
  if (!ref || !mail) return null;
  const { rows } = await client.query(
    `SELECT * FROM proshop_order
     WHERE property_id = $1 AND reference = $2 AND lower(contact_email) = $3
       AND payment_status = 'paid' AND status <> 'cancelled'${lock ? ' FOR UPDATE' : ''}`,
    [propertyId, ref, mail]
  );
  return rows[0] ?? null;
}

// Every line of an order with how many can still be returned: bought minus
// everything already on a return that isn't rejected/cancelled.
async function loadOrderLinesWithReturnable(orderId, client = pool) {
  const { rows } = await client.query(
    `SELECT oi.id, oi.item_id, oi.item_name, oi.unit_price, oi.quantity,
            (oi.quantity - COALESCE((
              SELECT SUM(ri.quantity) FROM proshop_return_item ri
              JOIN proshop_return r ON r.id = ri.return_id
              WHERE ri.order_item_id = oi.id AND r.status NOT IN ('rejected', 'cancelled')
            ), 0))::int AS returnable_quantity
     FROM proshop_order_item oi WHERE oi.order_id = $1 ORDER BY oi.item_name`,
    [orderId]
  );
  return rows;
}

// Lines for a page of returns in one query. item_id rides along so
// restoreStockForItems can use these rows directly.
async function loadReturnItems(returnIds) {
  const byReturn = new Map();
  if (!returnIds.length) return byReturn;
  const { rows } = await pool.query(
    `SELECT ri.return_id, ri.order_item_id, ri.quantity, oi.item_id, oi.item_name, oi.unit_price
     FROM proshop_return_item ri JOIN proshop_order_item oi ON oi.id = ri.order_item_id
     WHERE ri.return_id = ANY($1) ORDER BY oi.item_name`,
    [returnIds]
  );
  for (const row of rows) {
    if (!byReturn.has(row.return_id)) byReturn.set(row.return_id, []);
    byReturn.get(row.return_id).push(row);
  }
  return byReturn;
}

const RETURN_SELECT = `SELECT r.*, o.reference, o.contact_name, o.contact_email
                       FROM proshop_return r JOIN proshop_order o ON o.id = r.order_id`;

async function loadReturn(returnId, propertyId) {
  const { rows } = await pool.query(`${RETURN_SELECT} WHERE r.id = $1 AND r.property_id = $2`, [returnId, propertyId]);
  if (!rows.length) return null;
  const items = await loadReturnItems([rows[0].id]);
  return { ...rows[0], items: items.get(rows[0].id) ?? [] };
}

// The return behind an enquiry thread, or null for a general enquiry.
async function loadReturnForInquiry(inquiryId) {
  const { rows } = await pool.query(`${RETURN_SELECT} WHERE r.event_inquiry_id = $1`, [inquiryId]);
  if (!rows.length) return null;
  const items = await loadReturnItems([rows[0].id]);
  return { ...rows[0], items: items.get(rows[0].id) ?? [] };
}

// The enquiry's message body. lines: [{ item_name, quantity }].
function buildReturnMessage(reference, lines, reason) {
  const body = [`Return request for order ${reference}`, ''];
  for (const line of lines) body.push(`${line.quantity} × ${line.item_name}`);
  body.push('', `Reason: ${String(reason ?? '').trim() || '(none given)'}`);
  return body.join('\n');
}

module.exports = {
  RETURN_STATUSES, RETURN_TRANSITIONS, RETURN_EVENT_TYPE,
  findOrderByReferenceAndEmail, loadOrderLinesWithReturnable, loadReturnItems,
  loadReturn, loadReturnForInquiry, buildReturnMessage,
};
```

- [ ] **Step 2: Ably publisher**

In `src/lib/ably.js`, after `publishProshopOrderStatusChanged`:

```js
// Same shop-orders channel as orders. <live-shop-orders-feed> subscribes
// by event name and ignores this one until a hotal-ui release consumes it.
async function publishProshopReturnStatusChanged(propertyId, payload) {
  if (!client) return;
  const channel = client.channels.get(`property:${propertyId}:shop-orders`);
  await channel.publish('return-status-changed', payload);
}
```

Add `publishProshopReturnStatusChanged,` to `module.exports`.

- [ ] **Step 3: Verify it loads**

```bash
cd /c/Users/robert/source/repos/OTA && node -e "const r=require('./src/lib/proshopReturns');console.log(r.RETURN_TRANSITIONS.requested, r.buildReturnMessage('AB12CD',[{item_name:'Tee',quantity:2}],''));console.log(typeof require('./src/lib/ably').publishProshopReturnStatusChanged)"
```

Expected:

```
[ 'approved', 'rejected', 'cancelled' ] Return request for order AB12CD

2 × Tee

Reason: (none given)
function
```

- [ ] **Step 4: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/lib/proshopReturns.js src/lib/ably.js && git commit -m "Add the pro-shop returns library and Ably publisher

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 3: Lookup, list, get, and status endpoints (OTA)

**Files:**
- Modify: `src/controllers/proshop.js` (imports at top; new handlers before `module.exports`; exports)
- Modify: `src/routes/proshop.js`
- Modify: `src/docs/swagger.js` (after the `/api/proshop/orders/{id}/confirm-payment` entry)

**Interfaces:**
- Consumes: everything exported by `src/lib/proshopReturns.js` (Task 2), `restoreStockForItems(items)` (existing, same file), `publishProshopReturnStatusChanged` (Task 2).
- Produces: `POST /api/proshop/orders/lookup`, `GET /api/proshop/returns`, `GET /api/proshop/returns/:id`, `PUT /api/proshop/returns/:id`.

- [ ] **Step 1: Imports**

At the top of `src/controllers/proshop.js`, extend the Ably import and add the library:

```js
const {
  publishProshopItemAdded,
  publishProshopItemRemoved,
  publishNewProshopOrder,
  publishProshopOrderStatusChanged,
  publishProshopReturnStatusChanged,
} = require('../lib/ably');
const {
  RETURN_STATUSES, RETURN_TRANSITIONS,
  findOrderByReferenceAndEmail, loadOrderLinesWithReturnable, loadReturnItems, loadReturn,
} = require('../lib/proshopReturns');
```

- [ ] **Step 2: Handlers**

Before `module.exports` add:

```js
// ── Returns ───────────────────────────────────────────────────────────────────
// Design: docs/superpowers/specs/2026-09-08-proshop-returns-design.md.

// Guest-facing order lookup: reference + the email on the order. The same
// 404 for a wrong reference, a wrong email, or an unpaid/cancelled order,
// so the endpoint can't be used to probe which half was right.
async function lookupOrder(req, res, next) {
  try {
    const { reference, email } = req.body ?? {};
    const order = await findOrderByReferenceAndEmail(req.property_id, reference, email);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const items = await loadOrderLinesWithReturnable(order.id);
    const { stripe_payment_intent_id, ...publicOrder } = order;
    res.json({ ...publicOrder, items });
  } catch (err) { next(err); }
}

async function listReturns(req, res, next) {
  try {
    const { status, order_id, cursor, limit } = req.query;
    const take = Math.min(parseInt(limit, 10) || 30, 100);
    let query = `SELECT r.*, o.reference, o.contact_name, o.contact_email
                 FROM proshop_return r JOIN proshop_order o ON o.id = r.order_id
                 WHERE r.property_id = $1`;
    const params = [req.property_id];
    if (status) { params.push(status); query += ` AND r.status = $${params.length}`; }
    if (order_id) { params.push(order_id); query += ` AND r.order_id = $${params.length}`; }
    if (cursor) { params.push(cursor); query += ` AND r.created_at < $${params.length}`; }
    params.push(take);
    query += ` ORDER BY r.created_at DESC LIMIT $${params.length}`;
    const { rows: returns } = await pool.query(query, params);
    const items = await loadReturnItems(returns.map((r) => r.id));
    for (const r of returns) r.items = items.get(r.id) ?? [];
    res.json(returns);
  } catch (err) { next(err); }
}

async function getReturn(req, res, next) {
  try {
    const ret = await loadReturn(req.params.id, req.property_id);
    if (!ret) return res.status(404).json({ error: 'Return not found' });
    res.json(ret);
  } catch (err) { next(err); }
}

// Status only. Legal moves are RETURN_TRANSITIONS; 'received' puts the
// returned quantities back into stock (the goods are on the shelf again).
// The UPDATE is conditional on the status we validated against, so two
// staff changing it at once can't both succeed.
async function updateReturnStatus(req, res, next) {
  try {
    const { status } = req.body ?? {};
    if (!RETURN_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${RETURN_STATUSES.join(', ')}` });
    }
    const current = await loadReturn(req.params.id, req.property_id);
    if (!current) return res.status(404).json({ error: 'Return not found' });
    if (!RETURN_TRANSITIONS[current.status].includes(status)) {
      return res.status(409).json({ error: `Cannot move a return from '${current.status}' to '${status}'` });
    }
    const { rows } = await pool.query(
      `UPDATE proshop_return SET status = $1, updated_at = now()
       WHERE id = $2 AND property_id = $3 AND status = $4 RETURNING *`,
      [status, req.params.id, req.property_id, current.status]
    );
    if (!rows.length) return res.status(409).json({ error: 'Return changed while updating — reload and try again' });
    if (status === 'received') await restoreStockForItems(current.items);
    publishProshopReturnStatusChanged(req.property_id, { id: current.id, order_id: current.order_id, reference: current.reference, status })
      .catch((err) => console.error('Ably publish failed:', err.message));
    res.json({ ...current, ...rows[0], items: current.items });
  } catch (err) { next(err); }
}
```

Extend `module.exports`:

```js
module.exports = {
  listShops, createShop, updateShop,
  listItems, createItem, updateItem,
  listBookingItems, addBookingItem, removeBookingItem,
  listOrders, getOrder, createOrder, updateOrder,
  createOrderPaymentIntent, confirmOrderPayment,
  lookupOrder, listReturns, getReturn, updateReturnStatus,
};
```

- [ ] **Step 3: Routes**

In `src/routes/proshop.js`, `/orders/lookup` must be registered BEFORE `/orders/:id` or Express will treat "lookup" as an id. Replace the Orders block with:

```js
// Orders (guest self-checkout from the venue's website, no booking)
router.get('/orders', authenticateOrApiKey, ctrl.listOrders);
router.post('/orders/lookup', authenticateOrApiKey, ctrl.lookupOrder); // before /orders/:id
router.get('/orders/:id', authenticateOrApiKey, ctrl.getOrder);
router.post('/orders', authenticateOrApiKey, ctrl.createOrder);
router.put('/orders/:id', authenticateOrApiKey, ctrl.updateOrder);
router.post('/orders/:id/payment-intent', authenticateOrApiKey, ctrl.createOrderPaymentIntent);
router.post('/orders/:id/confirm-payment', authenticateOrApiKey, ctrl.confirmOrderPayment);

// Returns (guest via website, or staff via dashboard) -- managed as enquiries
router.get('/returns', authenticateOrApiKey, ctrl.listReturns);
router.get('/returns/:id', authenticateOrApiKey, ctrl.getReturn);
router.put('/returns/:id', authenticateOrApiKey, ctrl.updateReturnStatus);
```

(`POST /returns` is added in Task 7.)

- [ ] **Step 4: Swagger**

In `src/docs/swagger.js`, after the `/api/proshop/orders/{id}/confirm-payment` entry, add:

```js
    '/api/proshop/orders/lookup': {
      post: { tags: ['Pro Shop'], summary: 'Find a paid order by reference + email (guest-facing, for returns)', description: 'Returns the order and its lines with returnable_quantity per line (bought minus quantities on returns not rejected/cancelled). The same 404 for a wrong reference, wrong email, or an unpaid/cancelled order.', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reference', 'email'], properties: { reference: { type: 'string', description: '6-character order reference, case-insensitive' }, email: { type: 'string', description: 'Email on the order, case-insensitive' } } } } } }, responses: { 200: { description: 'Order + items[] with returnable_quantity' }, 404: { description: 'Order not found' } } },
    },
    '/api/proshop/returns': {
      get: { tags: ['Pro Shop'], summary: 'List returns', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled'] } }, { name: 'order_id', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'cursor', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 30, maximum: 100 } }], responses: { 200: { description: 'Array of returns, each with reference, event_inquiry_id and items[]' } } },
    },
    '/api/proshop/returns/{id}': {
      get: { tags: ['Pro Shop'], summary: 'Get a return with its lines', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Return + items' }, 404: { description: 'Not found' } } },
      put: { tags: ['Pro Shop'], summary: "Change a return's status", description: "Legal moves: requested→approved|rejected|cancelled, approved→received|cancelled, received→refunded|cancelled. 'received' restores stock for the returned quantities. Refunds are not automated -- 'refunded' records one done in Stripe.", security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled'] } } } } } }, responses: { 200: { description: 'Updated return' }, 400: { description: 'Unknown status' }, 404: { description: 'Not found' }, 409: { description: 'Illegal transition' } } },
    },
```

- [ ] **Step 5: Verify**

Restart the server. Use the order from Task 1 (it's unpaid, so lookup must 404) and then mark it paid directly in the DB to test the happy path:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/proshop/orders/lookup -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"reference":"<REF>","email":"ref@example.com"}'
```

Expected: `404`.

```bash
cd /c/Users/robert/source/repos/OTA && node -e "require('dotenv').config();const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query(\"UPDATE proshop_order SET status='paid', payment_status='paid' WHERE reference='<REF>'\");await c.end();})()"
curl -s -X POST http://localhost:3000/api/proshop/orders/lookup -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"reference":"<ref lower-case>","email":"REF@example.com"}'
```

Expected: 200 with `items[0].returnable_quantity === 1` (case-insensitivity on both halves proven). Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/proshop/returns -H "X-Api-Key: $OTA_KEY"
```

Expected: `200` with `[]`.

- [ ] **Step 6: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/controllers/proshop.js src/routes/proshop.js src/docs/swagger.js && git commit -m "Add order lookup and return list/get/status endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 4: `return_instructions` on the property settings endpoint (OTA)

**Files:**
- Modify: `src/controllers/property.js` (`getCurrentProperty`, `updateCurrentProperty`, ~43-85)
- Modify: `src/docs/swagger.js` (`/api/property/me` get/put, ~line 178)

**Interfaces:**
- Produces: `return_instructions` (string | null) on `GET /api/property/me`; accepted by `PUT /api/property/me`.

- [ ] **Step 1: Controller**

In `getCurrentProperty`, change the SELECT to:

```js
      'SELECT id, name, currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions FROM property WHERE id = $1',
```

In `updateCurrentProperty`, destructure and validate:

```js
    const { currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions } = req.body;
```

after the `tax_rate` check add:

```js
    if (return_instructions !== undefined && return_instructions !== null
        && (typeof return_instructions !== 'string' || return_instructions.length > 4000)) {
      return res.status(400).json({ error: 'return_instructions must be a string of at most 4000 characters' });
    }
```

and change the UPDATE to:

```js
    const { rows } = await pool.query(
      `UPDATE property SET
         currency            = COALESCE($1, currency),
         timezone            = COALESCE($2, timezone),
         tax_enabled         = COALESCE($3, tax_enabled),
         tax_rate            = COALESCE($4, tax_rate),
         tax_inclusive       = COALESCE($5, tax_inclusive),
         tax_id              = COALESCE($6, tax_id),
         return_instructions = CASE WHEN $8::boolean THEN $7::text ELSE return_instructions END
       WHERE id = $9
       RETURNING id, name, currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id, return_instructions`,
      [currency, timezone, tax_enabled, tax_rate, tax_inclusive, tax_id,
        return_instructions ?? null, return_instructions !== undefined, req.property_id]
    );
```

(The CASE lets an explicit `null` clear the text, which COALESCE couldn't.)

- [ ] **Step 2: Swagger**

In the `/api/property/me` `get` schema properties add `return_instructions: { type: 'string', nullable: true, description: 'Sent to guests requesting a shop return; also fed to AI replies' }`. In the `put` request body properties (find the `tax_id` property in that entry) add the same field with `description: 'null clears it; omit to leave unchanged'`.

- [ ] **Step 3: Verify**

Restart the server.

```bash
curl -s -X PUT http://localhost:3000/api/property/me -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"return_instructions":"Post items to Unit 4, Test Lane, quoting your order reference, within 30 days. Refunds go to the original card once received."}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).return_instructions.slice(0,20)))"
curl -s http://localhost:3000/api/property/me -H "X-Api-Key: $OTA_KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log('tax_enabled' in p, p.return_instructions.startsWith('Post items'))})"
```

Expected: `Post items to Unit 4,` then `true true`. Leave the instructions set — later tasks use them.

- [ ] **Step 4: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/controllers/property.js src/docs/swagger.js && git commit -m "Add return_instructions to the property settings endpoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 5: AI prompt knows about returns (OTA)

**Files:**
- Modify: `src/lib/inquiryReplies.js` (`loadInquiryWithProperty`, ~18-29)
- Modify: `src/lib/aiReplyPipeline.js` (requires at top; `generateDraft`, ~100-130)
- Modify: `src/lib/aiReplies.js` (`BASE_SYSTEM_PROMPT` ~75-135, `neutraliseTags` ~137, `buildPropertyBlock` ~161, `buildUserMessage` ~207, `generateInquiryReply` signature ~256 and the `buildUserMessage` call inside it)

**Interfaces:**
- Consumes: `loadReturnForInquiry(inquiryId)` (Task 2).
- Produces: `generateInquiryReply({ ..., returnRequest = null })`; `loadInquiryWithProperty` rows now carry `return_instructions`.

- [ ] **Step 1: Select the instructions with the inquiry**

In `loadInquiryWithProperty`, change the SELECT list to:

```sql
    `SELECT ei.*, p.name AS property_name, p.currency,
            p.ai_reply_mode, p.ai_reply_instructions, p.ai_reply_auto_send_min_score,
            p.fallback_email, p.email_branding, p.return_instructions
```

- [ ] **Step 2: Pipeline loads the return**

In `src/lib/aiReplyPipeline.js` add near the other requires:

```js
const { loadReturnForInquiry } = require('./proshopReturns');
```

In `generateDraft`, change the `Promise.all` to also load the return, and pass it through:

```js
  const [{ rows: thread }, { rows: restaurantRows }, spaContext, returnRequest] = await Promise.all([
    pool.query(
      'SELECT direction, body, created_at FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
      [inquiry.id]
    ),
    inquiry.restaurant_id
      ? pool.query('SELECT name, description FROM restaurant WHERE id = $1', [inquiry.restaurant_id])
      : Promise.resolve({ rows: [] }),
    inquiry.spa_id ? loadSpaContext(inquiry.spa_id) : Promise.resolve(null),
    loadReturnForInquiry(inquiry.id),
  ]);
```

```js
    const result = await generateInquiryReply({
      property: {
        name: inquiry.property_name, currency: inquiry.currency,
        ai_reply_instructions: inquiry.ai_reply_instructions, return_instructions: inquiry.return_instructions,
      },
      inquiry,
      restaurant: restaurantRows[0] ?? null,
      spa: spaContext,
      thread,
      triggerType,
      returnRequest,
    });
    // A proposal is only bookable against a spa diary, so it's dropped (not
    // stored) for inquiries without one -- and never for a return thread,
    // where a booking makes no sense whatever the model proposed.
    const proposal = inquiry.spa_id && !returnRequest ? result.proposed_booking : null;
```

- [ ] **Step 3: Prompt blocks**

In `src/lib/aiReplies.js`:

Append to `BASE_SYSTEM_PROMPT` (before the closing backtick, after the THREAD section):

```

RETURNS
- When <inquiry> contains a <return> block, the guest is returning shop items from a paid order. Confirm which items and the order reference, relay <return_instructions> from the venue section if present (do not invent a postal address, deadline or refund timing that isn't there), and never propose a booking. If the venue has no return instructions, say the team will follow up with next steps and set requires_human to true.
```

Update `neutraliseTags` so guest text can't close the new tags:

```js
function neutraliseTags(text) {
  return String(text ?? '').replace(/<\/?(inquiry|thread|message|field|venue_instructions|venue|restaurant|spa|trigger|return_instructions|return|line|reason)\b/gi, (m) => m.replace('<', '‹'));
}
```

In `buildPropertyBlock`, before `text += '</venue>\n\n<venue_instructions>\n';` add:

```js
  if (property.return_instructions?.trim()) {
    text += `  <return_instructions>${neutraliseTags(property.return_instructions.trim())}</return_instructions>\n`;
  }
```

In `buildUserMessage`, change the signature and add the block after `original_message`:

```js
function buildUserMessage({ inquiry, thread, triggerType, today, returnRequest = null }) {
  let text = '<inquiry>\n';
  text += field('guest_name', inquiry.name);
  text += field('event_date', inquiry.event_date);
  text += field('event_time', inquiry.event_time);
  text += field('guests', inquiry.guests);
  text += field('event_type', inquiry.event_type);
  text += field('format', inquiry.format);
  text += field('original_message', inquiry.message);
  if (returnRequest) {
    text += `  <return order_reference="${neutraliseTags(returnRequest.reference)}" status="${returnRequest.status}">\n`;
    for (const line of returnRequest.items) {
      text += `    <line quantity="${line.quantity}">${neutraliseTags(line.item_name)}</line>\n`;
    }
    if (returnRequest.reason) text += `    <reason>${neutraliseTags(returnRequest.reason)}</reason>\n`;
    text += '  </return>\n';
  }
  text += '</inquiry>\n\n<thread>\n';
```

In `generateInquiryReply`, add `returnRequest = null` to the destructured parameters and pass it to the call: `buildUserMessage({ inquiry, thread, triggerType, today, returnRequest })`.

- [ ] **Step 4: Verify the prompt text**

```bash
cd /c/Users/robert/source/repos/OTA/src/lib && node -e "
const src=require('fs').readFileSync('aiReplies.js','utf8');
// buildUserMessage isn't exported; evaluate the file with a shim to reach it.
// Run from src/lib so the file's require('./aiReplyTools') resolves.
const fn=new Function('module','exports','require','process','console',src+';return {buildUserMessage, buildPropertyBlock};');
const {buildUserMessage,buildPropertyBlock}=fn({exports:{}},{},require,process,console);
console.log(buildUserMessage({inquiry:{name:'Ann',message:'x'},thread:[],triggerType:'new_inquiry',today:'2026-09-08',returnRequest:{reference:'AB12CD',status:'requested',reason:'Too <small>',items:[{quantity:2,item_name:'Tee</return>'}]}}).split('</inquiry>')[0]);
console.log(buildPropertyBlock({name:'Shop',return_instructions:'Post it back'},null,null).includes('<return_instructions>Post it back</return_instructions>'));
"
```

Expected: the `<return ...>` block with two lines, the `</return>` inside the item name neutralised to `‹/return>`, and `true`.

- [ ] **Step 5: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/lib/inquiryReplies.js src/lib/aiReplyPipeline.js src/lib/aiReplies.js && git commit -m "Feed return requests and return instructions into AI reply drafts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 6: Fallback acknowledgement email and `ensureFirstReply` (OTA)

**Files:**
- Modify: `src/lib/resend.js` (new sender after `sendReply`, ~line 102; exports)
- Modify: `src/lib/inquiryReplies.js` (split `sendOutboundReply`; exports)
- Modify: `src/lib/proshopReturns.js` (add `ensureFirstReply`; requires; exports)

**Interfaces:**
- Consumes: `brandingHeaderHtml`, `escapeHtml`, `textToHtmlParagraphs` (existing in `resend.js`); `loadInquiryWithProperty`, `loadReturnForInquiry`.
- Produces: `sendReturnAcknowledgement(inquiry, ret, propertyName, instructions, branding) → { id, body }`; `recordOutboundReply({ inquiry, body, emailId, sender = null, aiDraftId = null }) → { message, inquiry }`; `ensureFirstReply(inquiryId) → message | null`.

- [ ] **Step 1: The email**

In `src/lib/resend.js`, after `sendReply`:

```js
// The guaranteed first reply on a return request when the AI pipeline
// didn't send one itself (mode off, draft awaiting a human, out of tokens,
// model failure). Free: no token is spent. `ret` is loadReturnForInquiry's
// shape (reference, reason, items[{ item_name, quantity }]). Returns the
// Resend id and the plain-text body, which the caller stores on the thread.
async function sendReturnAcknowledgement(inquiry, ret, propertyName, instructions, branding = undefined) {
  if (!client) throw new Error('Resend not configured');
  const firstName = String(inquiry.name ?? '').trim().split(/\s+/)[0] || 'there';
  const lineTexts = ret.items.map((i) => `${i.quantity} × ${i.item_name}`);
  const reason = String(ret.reason ?? '').trim();
  const nextSteps = String(instructions ?? '').trim() || "We'll be in touch with next steps.";

  const lines = [
    `Hi ${firstName},`,
    '',
    `We've received your return request for order ${ret.reference}.`,
    '',
    ...lineTexts,
    '',
    ...(reason ? [`Reason: ${reason}`, ''] : []),
    nextSteps,
    '',
    `The team at ${propertyName}`,
  ];
  const text = lines.join('\n');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto;">
      ${brandingHeaderHtml(branding, propertyName)}
      <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 16px;">We've received your return request for order <strong>${escapeHtml(ret.reference)}</strong>.</p>
      <div style="background:#f6f6f4;border-radius:8px;padding:18px 20px;margin:0 0 16px;">
        ${lineTexts.map((l) => `<div style="font-size:14px;">${escapeHtml(l)}</div>`).join('')}
      </div>
      ${reason ? `<p style="margin:0 0 16px;color:#555;">Reason: ${escapeHtml(reason)}</p>` : ''}
      ${textToHtmlParagraphs(nextSteps)}
      <p style="margin:16px 0 0;">The team at ${escapeHtml(propertyName)}</p>
    </div>`;

  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <inquiries@hotal.forge-build.co.uk>`,
    to: inquiry.email,
    replyTo: `inquiry+${inquiry.id}@${process.env.RESEND_REPLY_DOMAIN}`,
    subject: `Return request received — ${propertyName}`,
    text,
    html,
  });
  if (error) throw new Error(error.message);
  return { id: data.id, body: text };
}
```

Add `sendReturnAcknowledgement,` to `module.exports`.

- [ ] **Step 2: Split `sendOutboundReply`**

In `src/lib/inquiryReplies.js`, replace everything from `const { rows } = await pool.query(` (the INSERT into `event_inquiry_message`) to the end of `sendOutboundReply` with a call to a new function, so the file reads:

```js
async function sendOutboundReply({ inquiry, body, sender = null, aiDraftId = null }) {
  const spent = await tokens.spend(inquiry.property_id, 'reply_send', inquiry.id);
  if (!spent.ok) throw new InsufficientTokensError(spent.balance, spent.cost);

  const { rows: priorMessages } = await pool.query(
    'SELECT direction, body, sent_by_name, created_at FROM event_inquiry_message WHERE event_inquiry_id = $1 ORDER BY created_at ASC',
    [inquiry.id]
  );

  // Send first, persist second: a Resend failure here means nothing was
  // sent and nothing is recorded, so the caller can simply retry.
  // Branding: the enquiry's own per-request value wins, else the property's
  // Settings -> Branding default -- same precedence as spa booking emails.
  const branding = inquiry.branding ?? inquiry.email_branding ?? undefined;
  const emailId = await sendReply(inquiry, inquiry.property_name, body, priorMessages, branding);

  return recordOutboundReply({ inquiry, body, emailId, sender, aiDraftId });
}

// The persistence half of an outbound reply, after the email has gone: the
// message row, the new->contacted flip, and the Ably publishes. Shared by
// sendOutboundReply and the free return acknowledgement
// (proshopReturns.ensureFirstReply), which sends its own email and pays no
// token. Returns { message, inquiry } where inquiry reflects any status flip.
async function recordOutboundReply({ inquiry, body, emailId, sender = null, aiDraftId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO event_inquiry_message (event_inquiry_id, direction, body, resend_email_id, sent_by_user_id, sent_by_name, sent_by_avatar_url, ai_draft_id)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7) RETURNING *`,
    [inquiry.id, body, emailId, sender?.user_id ?? null, sender?.name ?? null, sender?.avatar_url ?? null, aiDraftId]
  );
  const message = rows[0];

  // The returned inquiry keeps the shape createReply always responded with:
  // the bare updated row after a status flip, otherwise the loaded row --
  // minus the property's AI settings and email branding, which are joined
  // in for the pipeline/send and have no business in a reply response.
  const { ai_reply_mode, ai_reply_instructions, ai_reply_auto_send_min_score, email_branding, return_instructions, ...publicInquiry } = inquiry;
  let updatedInquiry = publicInquiry;
  if (inquiry.status === 'new') {
    const { rows: statusRows } = await pool.query(
      `UPDATE event_inquiry SET status = 'contacted' WHERE id = $1 RETURNING *`,
      [inquiry.id]
    );
    updatedInquiry = statusRows[0];
    publishInquiryUpdated(inquiry.property_id, updatedInquiry).catch((err) => console.error('Ably publish failed:', err.message));
    if (inquiry.spa_id) {
      publishInquiryUpdatedForSpa(inquiry.spa_id, updatedInquiry).catch((err) => console.error('Ably publish failed:', err.message));
    }
  }

  // Same payload shape as the inbound-webhook publish, so feed clients
  // handle staff, AI and guest replies identically -- the message row
  // carries direction, sender attribution and ai_draft_id.
  publishNewReply(inquiry.property_id, { inquiry_id: inquiry.id, name: inquiry.name, message })
    .catch((err) => console.error('Ably publish failed:', err.message));
  if (inquiry.spa_id) {
    publishNewReplyForSpa(inquiry.spa_id, { inquiry_id: inquiry.id, name: inquiry.name, message })
      .catch((err) => console.error('Ably publish failed:', err.message));
  }

  return { message, inquiry: updatedInquiry };
}

module.exports = { loadInquiryWithProperty, sendOutboundReply, recordOutboundReply };
```

Keep the existing comment block above `sendOutboundReply`. (Note the added `return_instructions` in the destructure so it doesn't leak into reply responses.)

- [ ] **Step 3: `ensureFirstReply`**

In `src/lib/proshopReturns.js` add the requires after the existing ones:

```js
const { loadInquiryWithProperty, recordOutboundReply } = require('./inquiryReplies');
const { sendReturnAcknowledgement } = require('./resend');
```

and this function before `module.exports`:

```js
// Called once the AI pipeline has finished with a brand-new return enquiry.
// If nothing has gone out to the guest (mode off, a draft still pending,
// out of tokens, model failure), send the plain acknowledgement so the
// guest always hears back at once. Recorded on the thread like an auto-sent
// draft (no sender), so staff see it and the model reads it next time. A
// pending draft is left pending -- staff can still approve it as a richer
// follow-up.
async function ensureFirstReply(inquiryId) {
  const { rows: sent } = await pool.query(
    `SELECT 1 FROM event_inquiry_message WHERE event_inquiry_id = $1 AND direction = 'outbound' LIMIT 1`,
    [inquiryId]
  );
  if (sent.length) return null;
  const [inquiry, ret] = await Promise.all([loadInquiryWithProperty(inquiryId), loadReturnForInquiry(inquiryId)]);
  if (!inquiry || !ret) return null;
  const branding = inquiry.branding ?? inquiry.email_branding ?? undefined;
  const { id: emailId, body } = await sendReturnAcknowledgement(inquiry, ret, inquiry.property_name, inquiry.return_instructions, branding);
  const { message } = await recordOutboundReply({ inquiry, body, emailId });
  return message;
}
```

Add `ensureFirstReply,` to the exports.

- [ ] **Step 4: Verify no import cycle and the email text**

```bash
cd /c/Users/robert/source/repos/OTA && node -e "
const r=require('./src/lib/proshopReturns');const ir=require('./src/lib/inquiryReplies');
console.log(typeof r.ensureFirstReply, typeof ir.recordOutboundReply, typeof ir.sendOutboundReply);
"
```

Expected: `function function function` (a require cycle would surface as `undefined` for one of them).

- [ ] **Step 5: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/lib/resend.js src/lib/inquiryReplies.js src/lib/proshopReturns.js && git commit -m "Add the return acknowledgement email and a guaranteed first reply

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 7: Create a return (OTA)

**Files:**
- Modify: `src/controllers/proshop.js` (imports; new `createReturn` before `module.exports`; exports)
- Modify: `src/routes/proshop.js`
- Modify: `src/docs/swagger.js` (`/api/proshop/returns` entry: add `post`)

**Interfaces:**
- Consumes: `findOrderByReferenceAndEmail`, `loadOrderLinesWithReturnable`, `loadReturn`, `buildReturnMessage`, `RETURN_EVENT_TYPE`, `ensureFirstReply` (library); `validateBranding`, `isValidUuid` (`src/middleware/validate.js`); `publishNewInquiry` (`src/lib/ably.js`); `runAiReply` (`src/lib/aiReplyPipeline.js`).
- Produces: `POST /api/proshop/returns` → 201 `{ ...inquiry, return }`.

- [ ] **Step 1: Imports**

Extend the library import in `src/controllers/proshop.js`:

```js
const {
  RETURN_STATUSES, RETURN_TRANSITIONS, RETURN_EVENT_TYPE,
  findOrderByReferenceAndEmail, loadOrderLinesWithReturnable, loadReturnItems, loadReturn,
  buildReturnMessage, ensureFirstReply,
} = require('../lib/proshopReturns');
const { validateBranding, isValidUuid } = require('../middleware/validate');
const { publishNewInquiry } = require('../lib/ably');
const { runAiReply } = require('../lib/aiReplyPipeline');
```

(Merge `publishNewInquiry` into the existing `require('../lib/ably')` destructure rather than a second require.)

- [ ] **Step 2: Handler**

Before `module.exports`:

```js
// Two body shapes: a guest (website, API key) sends { reference, email };
// staff (dashboard, Clerk token) may send { order_id } instead. Everything
// else is common: reason, items [{ order_item_id, quantity }], branding.
// One transaction inserts the enquiry thread, the return and its lines,
// with the order row locked so two simultaneous requests can't both pass
// the quantity cap. No token gate (unlike createInquiry): the return must
// be recorded regardless, and the fallback acknowledgement is free.
async function createReturn(req, res, next) {
  try {
    const { reference, email, order_id, reason, items, branding } = req.body ?? {};
    const staffRail = req.auth_method === 'bearer';
    if (order_id !== undefined && !staffRail) {
      return res.status(400).json({ error: 'order_id is only accepted from the dashboard; send reference and email' });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items must be a non-empty array of { order_item_id, quantity }' });
    }
    if (reason != null && (typeof reason !== 'string' || reason.length > 2000)) {
      return res.status(400).json({ error: 'reason must be a string of at most 2000 characters' });
    }
    const brandingError = validateBranding(branding);
    if (brandingError) return res.status(400).json({ error: brandingError });
    const seen = new Set();
    for (const line of items) {
      const qty = Number(line?.quantity);
      if (!line?.order_item_id || !isValidUuid(line.order_item_id) || !Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({ error: 'Each item needs a valid order_item_id and a positive integer quantity' });
      }
      if (seen.has(line.order_item_id)) return res.status(400).json({ error: `Duplicate order_item_id ${line.order_item_id}` });
      seen.add(line.order_item_id);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let order;
      if (order_id !== undefined) {
        if (!isValidUuid(order_id)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
        ({ rows: [order] } = await client.query(
          `SELECT * FROM proshop_order WHERE id = $1 AND property_id = $2
             AND payment_status = 'paid' AND status <> 'cancelled' FOR UPDATE`,
          [order_id, req.property_id]
        ));
      } else {
        order = await findOrderByReferenceAndEmail(req.property_id, reference, email, client, { lock: true });
      }
      if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Order not found' }); }
      if (!order.contact_email) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Order has no email address to reply to' });
      }

      const lines = await loadOrderLinesWithReturnable(order.id, client);
      const byId = new Map(lines.map((l) => [l.id, l]));
      const returnLines = [];
      for (const { order_item_id, quantity } of items) {
        const line = byId.get(order_item_id);
        if (!line) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Item ${order_item_id} is not on this order` }); }
        const qty = Number(quantity);
        if (qty > line.returnable_quantity) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `Only ${line.returnable_quantity} of "${line.item_name}" can still be returned` });
        }
        returnLines.push({ order_item_id, quantity: qty, item_name: line.item_name });
      }

      const message = buildReturnMessage(order.reference, returnLines, reason);
      const { rows: [inquiry] } = await client.query(
        `INSERT INTO event_inquiry (property_id, name, email, phone, event_type, message, branding)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.property_id, order.contact_name, order.contact_email, order.contact_phone, RETURN_EVENT_TYPE, message,
          branding ? JSON.stringify(branding) : null]
      );
      const { rows: [ret] } = await client.query(
        `INSERT INTO proshop_return (property_id, order_id, event_inquiry_id, reason, raised_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.property_id, order.id, inquiry.id, String(reason ?? '').trim() || null, staffRail ? 'staff' : 'guest']
      );
      for (const l of returnLines) {
        await client.query(
          `INSERT INTO proshop_return_item (return_id, order_item_id, quantity) VALUES ($1, $2, $3)`,
          [ret.id, l.order_item_id, l.quantity]
        );
      }
      await client.query('COMMIT');

      const full = await loadReturn(ret.id, req.property_id);
      const payload = { ...inquiry, return: full };
      publishNewInquiry(req.property_id, payload).catch((err) => console.error('Ably publish failed:', err.message));
      // Fire-and-forget like createInquiry: drafting takes tens of seconds.
      // Whatever the pipeline does (auto-send, draft, off, out of tokens,
      // failure), ensureFirstReply then guarantees the guest one reply.
      runAiReply({ inquiryId: inquiry.id, triggerType: 'new_inquiry' })
        .catch((err) => console.error('AI reply pipeline failed:', err.message))
        .then(() => ensureFirstReply(inquiry.id))
        .catch((err) => console.error(`Return acknowledgement failed for inquiry ${inquiry.id}:`, err.message));

      res.status(201).json(payload);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
}
```

Add `createReturn,` to `module.exports`.

- [ ] **Step 3: Route and swagger**

In `src/routes/proshop.js`, in the Returns block add:

```js
router.post('/returns', authenticateOrApiKey, ctrl.createReturn);
```

In `src/docs/swagger.js`, inside the `'/api/proshop/returns'` entry add a `post`:

```js
      post: { tags: ['Pro Shop'], summary: 'Request a return of items from a paid order', description: 'Guest shape (website, API key): { reference, email, reason?, items, branding? }. Staff shape (dashboard, Clerk token only): { order_id, reason?, items }. Creates the return AND an event_inquiry thread (event_type "Return order items") in one transaction; the thread is where staff manage it. Kicks off the AI reply pipeline; if that does not send, a plain acknowledgement with the property\'s return_instructions goes to the guest. Per line, quantity may not exceed bought minus quantities on returns not rejected/cancelled.', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { reference: { type: 'string' }, email: { type: 'string' }, order_id: { type: 'string', format: 'uuid', description: 'Dashboard only' }, reason: { type: 'string', maxLength: 2000 }, items: { type: 'array', items: { type: 'object', required: ['order_item_id', 'quantity'], properties: { order_item_id: { type: 'string', format: 'uuid' }, quantity: { type: 'integer', minimum: 1 } } } }, branding: { type: 'object', properties: { logo_url: { type: 'string' }, brand_color: { type: 'string' }, header_bg: { type: 'string' } } } } } } } }, responses: { 201: { description: 'The enquiry row with `return` embedded' }, 400: { description: 'Bad items/reason/branding, order_id from an API-key caller, or a line not on the order' }, 404: { description: 'Order not found' }, 409: { description: 'Quantity exceeds what can still be returned, or the order has no email' } } },
```

- [ ] **Step 4: Verify**

Restart the server. Use the paid order from Task 3 (`<REF>`, `ref@example.com`, one line). Get its line id:

```bash
curl -s -X POST http://localhost:3000/api/proshop/orders/lookup -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"reference":"<REF>","email":"ref@example.com"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).items[0].id))"
```

Cap and shape checks:

```bash
# too many -> 409
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/proshop/returns -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"reference":"<REF>","email":"ref@example.com","reason":"Wrong size","items":[{"order_item_id":"<LINE>","quantity":2}]}'
# order_id from the API-key rail -> 400
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/proshop/returns -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"order_id":"00000000-0000-0000-0000-000000000000","items":[{"order_item_id":"<LINE>","quantity":1}]}'
# happy path -> 201
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/proshop/returns -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"reference":"<REF>","email":"ref@example.com","reason":"Wrong size","items":[{"order_item_id":"<LINE>","quantity":1}]}'
# now fully returned -> 409 with "Only 0 of ..."
curl -s -w "\n%{http_code}\n" -X POST http://localhost:3000/api/proshop/returns -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"reference":"<REF>","email":"ref@example.com","items":[{"order_item_id":"<LINE>","quantity":1}]}'
```

Expected: `409`, `400`, `201` (body has `event_type: "Return order items"`, `message` starting `Return request for order <REF>`, and `return.status: "requested"`), then `409`.

First-reply check, within about a minute of the 201 (watch the server log for the pipeline), using the enquiry id from the 201 body:

```bash
curl -s http://localhost:3000/api/event-inquiries/<INQUIRY_ID>/replies -H "X-Api-Key: $OTA_KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(m.length, m.map(x=>x.direction+':'+(x.ai_draft_id?'ai':'plain')))})"
```

Expected: exactly one outbound message: `1 [ 'outbound:ai' ]` when the property is in `auto` mode with a passing score, otherwise `1 [ 'outbound:plain' ]` (the acknowledgement; its body includes the return instructions set in Task 4). Never two.

Also run the transition checks now that a return exists (`<RET_ID>` from the 201 body's `return.id`):

```bash
curl -s -w "\n%{http_code}\n" -X PUT http://localhost:3000/api/proshop/returns/<RET_ID> -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"status":"received"}'
curl -s -w "\n%{http_code}\n" -X PUT http://localhost:3000/api/proshop/returns/<RET_ID> -H "X-Api-Key: $OTA_KEY" -H "Content-Type: application/json" -d '{"status":"approved"}'
```

Expected: `409` (requested → received is illegal), then `200` with `status: "approved"`.

- [ ] **Step 5: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/controllers/proshop.js src/routes/proshop.js src/docs/swagger.js && git commit -m "Add POST /api/proshop/returns, opening an enquiry thread per return

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 8: Embed the return on the enquiry list (OTA)

**Files:**
- Modify: `src/controllers/eventInquiries.js` (requires; `listInquiries`, ~23-43)
- Modify: `src/docs/swagger.js` (`/api/event-inquiries` get description)

**Interfaces:**
- Consumes: `loadReturnItems` (Task 2).
- Produces: every row of `GET /api/event-inquiries` has `return: { id, order_id, reference, status, reason, raised_by, items[] } | null`.

- [ ] **Step 1: Controller**

Add near the requires:

```js
const { loadReturnItems } = require('../lib/proshopReturns');
```

In `listInquiries`, replace `res.json(rows);` with:

```js
    // Return threads carry their return (order reference, lines, status)
    // so the reply dialog can render the panel without a second request.
    // Two queries for the whole page, not one per row.
    if (rows.length) {
      const { rows: returns } = await pool.query(
        `SELECT r.id, r.event_inquiry_id, r.order_id, r.status, r.reason, r.raised_by, o.reference
         FROM proshop_return r JOIN proshop_order o ON o.id = r.order_id
         WHERE r.event_inquiry_id = ANY($1)`,
        [rows.map((r) => r.id)]
      );
      const items = await loadReturnItems(returns.map((r) => r.id));
      const byInquiry = new Map(returns.map((r) => [r.event_inquiry_id, { ...r, items: items.get(r.id) ?? [] }]));
      for (const row of rows) row.return = byInquiry.get(row.id) ?? null;
    }
    res.json(rows);
```

- [ ] **Step 2: Swagger**

Change the `/api/event-inquiries` `get` response description to end with: `... Each includes last_reply_direction ('inbound'/'outbound'/null) for the feed's avatar-vs-status-badge display, and \`return\` ({ id, order_id, reference, status, reason, raised_by, items[] }) for return threads, null otherwise.`

- [ ] **Step 3: Verify**

Restart the server.

```bash
curl -s http://localhost:3000/api/event-inquiries -H "X-Api-Key: $OTA_KEY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);const r=a.find(x=>x.return);console.log(a.every(x=>'return' in x), r&&r.return.reference, r&&r.return.items.length, r&&r.return.status)})"
```

Expected: `true <REF> 1 approved`.

- [ ] **Step 4: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add src/controllers/eventInquiries.js src/docs/swagger.js && git commit -m "Embed the return on enquiry list rows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 9: MCP tools (OTA)

**Files:**
- Modify: `mcp-server/tools.js` (after `update_proshop_order_status`, ~line 463)

**Interfaces:**
- Consumes: the four endpoints from Tasks 3 and 7.

- [ ] **Step 1: Add the tools**

After the `update_proshop_order_status` tool object:

```js
  {
    name: 'lookup_proshop_order',
    description: 'Find a paid shop order by its 6-character reference and the email on the order (both case-insensitive). Returns the order and its lines with returnable_quantity per line. The same not-found error for a wrong reference, wrong email, or an unpaid/cancelled order.',
    inputSchema: { reference: z.string(), email: z.string() },
    run: (args) => apiRequest('POST', '/api/proshop/orders/lookup', { body: args }),
  },
  {
    name: 'create_proshop_return',
    description: 'Request a return of items from a paid shop order, identified by reference + email. Creates the return and an enquiry thread (event_type "Return order items") where staff manage it; the guest gets a first reply (AI, or a plain acknowledgement with the property\'s return instructions). Per line, quantity cannot exceed what was bought minus what is already on returns not rejected/cancelled.',
    inputSchema: {
      reference: z.string(),
      email: z.string(),
      reason: z.string().max(2000).optional(),
      items: z.array(z.object({ order_item_id: z.string(), quantity: z.number().int().min(1) })),
      branding: BRANDING_SCHEMA,
    },
    run: (args) => apiRequest('POST', '/api/proshop/returns', { body: args }),
  },
  {
    name: 'list_proshop_returns',
    description: 'List shop returns, newest first, each with its order reference, enquiry id, status and lines',
    inputSchema: {
      status: z.enum(['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled']).optional(),
      order_id: z.string().optional(),
      cursor: z.string().optional().describe('created_at of the last item from the previous page'),
      limit: z.number().int().optional(),
    },
    run: (args) => apiRequest('GET', '/api/proshop/returns', { query: args }),
  },
  {
    name: 'update_proshop_return_status',
    description: "Move a return along its flow: requested→approved|rejected|cancelled, approved→received|cancelled, received→refunded|cancelled. 'received' restores stock. Refunds are manual in Stripe; 'refunded' just records that.",
    inputSchema: { id: z.string(), status: z.enum(['requested', 'approved', 'rejected', 'received', 'refunded', 'cancelled']) },
    run: ({ id, status }) => apiRequest('PUT', `/api/proshop/returns/${id}`, { body: { status } }),
  },
```

- [ ] **Step 2: Verify**

```bash
cd /c/Users/robert/source/repos/OTA && node -e "const {createTools}=require('./mcp-server/tools');const names=createTools(()=>{}).map(x=>x.name);console.log(['lookup_proshop_order','create_proshop_return','list_proshop_returns','update_proshop_return_status'].every(n=>names.includes(n)), new Set(names).size===names.length)"
```

Expected: `true true` (all four present, no duplicate tool names).

- [ ] **Step 3: Commit and push**

```bash
cd /c/Users/robert/source/repos/OTA && git add mcp-server/tools.js && git commit -m "Add MCP tools for shop order lookup and returns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push
```

---

### Task 10: Return panel in the reply dialog (dashboard)

**Files:**
- Modify: `src/scripts/event-inquiry-dialogs.ts` (`Inquiry` type ~5-31; `buildInquiryDetailsHtml` ~118-141; `wireBookingFields` ~146; `openReplyDialog` ~404; `markInquiryBooked`)
- Modify: `src/styles/global.css` (after `.reply-inquiry-status[data-status='booked']`, ~2067)

**Interfaces:**
- Consumes: `inquiry.return` from Task 8; `PUT /api/proshop/returns/:id` from Task 3.

- [ ] **Step 1: Types and transition table**

After the `Inquiry` type's `spa_name` line add:

```ts
  // Present on return threads only (see OTA's proshopReturns.js) -- the
  // reply dialog swaps the booking fields for a return panel when set.
  return?: InquiryReturn | null;
```

Above `export type Inquiry` add:

```ts
export type InquiryReturn = {
  id: string;
  order_id: string;
  reference: string;
  status: ReturnStatus;
  reason: string | null;
  raised_by: 'guest' | 'staff';
  items: { order_item_id: string; item_name: string; quantity: number }[];
};

export type ReturnStatus = 'requested' | 'approved' | 'rejected' | 'received' | 'refunded' | 'cancelled';

// Mirrors OTA's RETURN_TRANSITIONS (src/lib/proshopReturns.js) -- the select
// only ever offers legal moves, so the 409 path is a race, not the norm.
const RETURN_TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['received', 'cancelled'],
  received: ['refunded', 'cancelled'],
  refunded: [],
  rejected: [],
  cancelled: [],
};
```

- [ ] **Step 2: Render the panel**

At the top of `buildInquiryDetailsHtml`, before `const meta = ...`, add:

```ts
    if (inquiry.return) return buildReturnDetailsHtml(inquiry, inquiry.return);
```

and add this function right after `buildInquiryDetailsHtml`:

```ts
  // Return threads: order reference, the lines coming back, the reason, and
  // a status control offering only the legal next moves. Contact details are
  // static here -- they came off the paid order, not a typed form.
  function buildReturnDetailsHtml(inquiry: Inquiry, ret: InquiryReturn): string {
    const contact = [inquiry.email, inquiry.phone].filter(Boolean).map((v) => escapeHtml(v!)).join(' · ');
    const options = [ret.status, ...RETURN_TRANSITIONS[ret.status]]
      .map((s) => `<option value="${s}"${s === ret.status ? ' selected' : ''}>${s[0]!.toUpperCase()}${s.slice(1)}</option>`)
      .join('');
    return `
      <div class="reply-inquiry-meta"><span>Return order items</span><span>Order ${escapeHtml(ret.reference)}</span><span>${ret.raised_by === 'staff' ? 'Raised by staff' : 'Raised by guest'}</span></div>
      <div class="reply-extras">
        <span class="reply-extras-label">Returning</span>
        <ul class="reply-extras-list">
          ${ret.items.map((i) => `<li><span>${i.quantity} × ${escapeHtml(i.item_name)}</span></li>`).join('')}
        </ul>
      </div>
      ${ret.reason ? `<p class="reply-inquiry-message">Reason: ${escapeHtml(ret.reason)}</p>` : ''}
      <div class="reply-booking-fields">
        <label>Return status
          <select id="reply-return-status"${RETURN_TRANSITIONS[ret.status].length ? '' : ' disabled'}>${options}</select>
        </label>
        <span class="reply-inquiry-status reply-return-badge" id="reply-return-badge" data-status="${ret.status}">${ret.status}</span>
      </div>
      <div class="reply-inquiry-received">${escapeHtml(inquiry.name)}${contact ? ` · ${contact}` : ''} · Received ${escapeHtml(formatMessageTime(inquiry.created_at))} · <span class="reply-inquiry-status" data-status="${escapeHtml(inquiry.status.toLowerCase())}">${escapeHtml(inquiry.status)}</span></div>
    `;
  }
```

- [ ] **Step 3: Wire the status control**

At the top of `wireBookingFields` add:

```ts
    if (inquiry.return) { wireReturnPanel(inquiry, inquiry.return); return; }
```

Add this function after `wireBookingFields`:

```ts
  // Status changes save immediately; on success the badge, the select's
  // option list and the cached inquiry all move to the new state so the
  // next change offers the right moves without a reload.
  function wireReturnPanel(inquiry: Inquiry, ret: InquiryReturn) {
    const select = document.getElementById('reply-return-status') as HTMLSelectElement | null;
    if (!select) return;
    select.addEventListener('change', async () => {
      const status = select.value as ReturnStatus;
      if (status === ret.status) return;
      select.disabled = true;
      try {
        const res = await apiFetch(`/api/proshop/returns/${ret.id}`, {
          method: 'PUT',
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(15000),
        });
        const updated = await res.json().catch(() => null);
        if (!res.ok || !updated) {
          showToast(`Failed to update return — ${updated?.error ?? 'unknown error'}`, 'error');
          select.value = ret.status;
          return;
        }
        const next: Inquiry = { ...inquiry, return: { ...ret, status: updated.status } };
        if (currentInquiry?.id === inquiry.id) currentInquiry = next;
        onInquiryUpdated?.(next);
        if (replyDialog.dataset.inquiryId === inquiry.id) {
          replyInquiryDetails.innerHTML = buildInquiryDetailsHtml(next);
          wireBookingFields(next);
        }
        showToast(`Return ${updated.status}`, 'success');
      } catch (err) {
        if (err instanceof Error && err.message === 'Not authenticated') return;
        select.value = ret.status;
        showToast('Failed to update return', 'error');
      } finally {
        select.disabled = false;
      }
    });
  }
```

- [ ] **Step 4: Hide "Convert to booking" on return threads**

In `openReplyDialog`, after `replyDialogTitle.textContent = ...` add:

```ts
    const convert = document.getElementById('convert-to-booking-btn') as HTMLButtonElement | null;
    if (convert) convert.hidden = !!inquiry.return;
```

- [ ] **Step 5: Badge colours**

In `src/styles/global.css` after the `booked` rule:

```css
/* Return statuses (reply dialog's return panel -- see
   event-inquiry-dialogs.ts buildReturnDetailsHtml). */
.reply-inquiry-status[data-status='requested'] {
  background: color-mix(in srgb, rgb(155, 93, 229) 18%, transparent);
  color: rgb(155, 93, 229);
}

.reply-inquiry-status[data-status='approved'] {
  background: color-mix(in srgb, #3b82f6 18%, transparent);
  color: #3b82f6;
}

.reply-inquiry-status[data-status='received'] {
  background: color-mix(in srgb, #f59e0b 18%, transparent);
  color: #f59e0b;
}

.reply-inquiry-status[data-status='refunded'] {
  background: color-mix(in srgb, #22c55e 18%, transparent);
  color: #22c55e;
}

.reply-inquiry-status[data-status='rejected'],
.reply-inquiry-status[data-status='cancelled'] {
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: #ef4444;
}

.reply-return-badge {
  align-self: center;
}
```

- [ ] **Step 6: Type-check and verify in the browser**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npx astro check 2>&1 | grep -E "event-inquiry-dialogs|error ts" | head
```

Expected: no lines for `event-inquiry-dialogs.ts`.

Start the dashboard (`astro dev --background`), sign in, open Event Inquiries, click the return enquiry from Task 7. Expected: the panel shows `Order <REF>`, `1 × <item>`, `Reason: Wrong size`, status badge `approved`, and the select offers Approved, Received, Cancelled only. Change to Received → toast `Return received`, badge turns amber, select now offers Received, Refunded, Cancelled. The Convert to booking button is hidden. Open a general enquiry → unchanged date/guests/time fields and the button is back. Screenshot the panel and check for dead space or misalignment (memory: verify layout changes visually).

- [ ] **Step 7: Commit**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git add src/scripts/event-inquiry-dialogs.ts src/styles/global.css && git commit -m "Show a return panel with a status control on return enquiries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Reference column and staff-raised returns in the Orders dialog (dashboard)

**Files:**
- Modify: `src/pages/pro-shop.astro` (orders dialog table; new return dialog before the script tag)
- Modify: `src/scripts/shop-client.ts` (`addOrderRow`, `loadOrders`; new return dialog section before the live feed section)

**Interfaces:**
- Consumes: `POST /api/proshop/orders/lookup` (Task 3), `POST /api/proshop/returns` staff shape (Task 7). `order.reference` on list rows (Task 1).

- [ ] **Step 1: Markup**

In `src/pages/pro-shop.astro`, change the orders dialog `<thead>` row to:

```html
            <tr>
              <th>Date</th>
              <th class="col-narrow">Ref</th>
              <th>Contact</th>
              <th class="col-grow">Items</th>
              <th class="col-narrow">Total</th>
              <th class="col-narrow">Payment</th>
              <th>Status</th>
              <th class="col-actions">Actions</th>
            </tr>
```

Before `<script src="../scripts/shop-client.ts"></script>` add:

```html
    <dialog id="return-dialog" class="list-dialog">
      <div class="list-dialog-header">
        <h2 id="return-dialog-title">Return</h2>
      </div>
      <div class="list-dialog-table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-grow">Item</th>
              <th class="col-narrow">Bought</th>
              <th class="col-narrow">Returnable</th>
              <th class="col-narrow">Return</th>
            </tr>
          </thead>
          <tbody id="return-dialog-body"></tbody>
        </table>
      </div>
      <label class="settings-form" for="return-dialog-reason">
        Reason
        <textarea id="return-dialog-reason" rows="3" maxlength="2000" placeholder="Optional"></textarea>
      </label>
      <div class="list-dialog-footer">
        <button id="return-dialog-cancel-btn" type="button" class="btn-link">Cancel</button>
        <button id="return-dialog-submit-btn" type="button">Raise return</button>
      </div>
    </dialog>
```

- [ ] **Step 2: Orders rows**

In `src/scripts/shop-client.ts`, replace `addOrderRow` with:

```ts
function addOrderRow(order: any) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${escapeHtml(formatOrderDate(order.created_at))}</td>
    <td><code>${escapeHtml(order.reference ?? '')}</code></td>
    <td>${escapeHtml(order.contact_name ?? '')}${order.contact_email ? `<br><span class="tables-sheet-empty" style="display:inline;padding:0;">${escapeHtml(order.contact_email)}</span>` : ''}</td>
    <td>${escapeHtml(formatOrderItems(order.items ?? []))}</td>
    <td>${escapeHtml(String(order.total_price ?? ''))}</td>
    <td>${order.payment_status === 'paid' ? 'Paid' : 'Unpaid'}</td>
    <td class="status-cell"></td>
    <td class="actions-cell"></td>
  `;
  const statusSelect = document.createElement('select');
  statusSelect.dataset.current = order.status;
  for (const status of ORDER_STATUSES) {
    const opt = document.createElement('option');
    opt.value = status;
    opt.textContent = status[0].toUpperCase() + status.slice(1);
    if (status === order.status) opt.selected = true;
    statusSelect.appendChild(opt);
  }
  statusSelect.addEventListener('change', () => saveOrderStatus(statusSelect, order.id));
  tr.querySelector('.status-cell')!.appendChild(statusSelect);

  // Only a paid, uncancelled order can have items returned -- same rule as
  // OTA's findOrderByReferenceAndEmail.
  if (order.payment_status === 'paid' && order.status !== 'cancelled') {
    const returnBtn = document.createElement('button');
    returnBtn.type = 'button';
    returnBtn.className = 'btn-link';
    returnBtn.textContent = 'Return';
    returnBtn.addEventListener('click', () => openReturnDialog(order));
    tr.querySelector('.actions-cell')!.appendChild(returnBtn);
  }
  return tr;
}
```

In `loadOrders`, change `colspan="6"` to `colspan="8"`.

- [ ] **Step 3: Return dialog**

Before the `// ── Live shop orders feed` section add:

```ts
// ── Staff-raised returns ──────────────────────────────────────
// Lines come from POST /orders/lookup with the order's own reference and
// email, so the returnable quantities here are exactly what OTA will
// enforce on submit. Submits the staff shape ({ order_id }) of
// POST /api/proshop/returns; the new enquiry then shows up under Enquiries.

const returnDialog = document.getElementById('return-dialog') as HTMLDialogElement;
const returnDialogTitle = document.getElementById('return-dialog-title')!;
const returnDialogBody = document.getElementById('return-dialog-body')!;
const returnDialogReason = document.getElementById('return-dialog-reason') as HTMLTextAreaElement;
const returnDialogCancelBtn = document.getElementById('return-dialog-cancel-btn') as HTMLButtonElement;
const returnDialogSubmitBtn = document.getElementById('return-dialog-submit-btn') as HTMLButtonElement;

type ReturnableLine = { id: string; item_name: string; quantity: number; returnable_quantity: number };

let returnDialogOrderId: string | null = null;

async function openReturnDialog(order: any) {
  if (!order.contact_email) {
    showToast('This order has no email address, so a return can’t be raised for it', 'warning');
    return;
  }
  returnDialogOrderId = order.id;
  returnDialogTitle.textContent = `Return — order ${order.reference}`;
  returnDialogReason.value = '';
  returnDialogBody.innerHTML =
    '<tr><td colspan="4" class="dialog-loading-cell"><span class="spinner spinner-sm"></span> Loading…</td></tr>';
  returnDialog.showModal();

  const res = await apiFetch('/api/proshop/orders/lookup', {
    method: 'POST',
    body: JSON.stringify({ reference: order.reference, email: order.contact_email }),
    cache: 'no-store',
  }).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  if (!data || returnDialogOrderId !== order.id) {
    if (!data) {
      showToast('Could not load the order’s lines', 'error');
      returnDialog.close();
    }
    return;
  }

  returnDialogBody.innerHTML = '';
  for (const line of data.items as ReturnableLine[]) {
    const tr = document.createElement('tr');
    const disabled = line.returnable_quantity === 0;
    tr.innerHTML = `
      <td>${escapeHtml(line.item_name)}${disabled ? ' <span class="tables-sheet-empty" style="display:inline;padding:0;">fully returned</span>' : ''}</td>
      <td>${line.quantity}</td>
      <td>${line.returnable_quantity}</td>
      <td><input type="number" class="return-qty" data-line-id="${escapeHtml(line.id)}" min="0" max="${line.returnable_quantity}" value="0"${disabled ? ' disabled' : ''} /></td>
    `;
    returnDialogBody.appendChild(tr);
  }
}

async function submitReturn() {
  if (!returnDialogOrderId) return;
  const items = [...returnDialogBody.querySelectorAll<HTMLInputElement>('.return-qty')]
    .map((input) => ({ order_item_id: input.dataset.lineId!, quantity: Number(input.value) }))
    .filter((line) => Number.isInteger(line.quantity) && line.quantity > 0);
  if (!items.length) {
    showToast('Enter a quantity for at least one item', 'warning');
    return;
  }
  returnDialogSubmitBtn.disabled = true;
  try {
    const res = await apiFetch('/api/proshop/returns', {
      method: 'POST',
      body: JSON.stringify({ order_id: returnDialogOrderId, reason: returnDialogReason.value.trim() || undefined, items }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      showToast(`Failed to raise return — ${data?.error ?? 'unknown error'}`, 'error');
      return;
    }
    showToast('Return raised — see Enquiries', 'success');
    returnDialog.close();
  } catch (err) {
    if (err instanceof Error && err.message === 'Not authenticated') return;
    showToast('Failed to raise return', 'error');
  } finally {
    returnDialogSubmitBtn.disabled = false;
  }
}

returnDialogSubmitBtn.addEventListener('click', submitReturn);
returnDialogCancelBtn.addEventListener('click', () => returnDialog.close());
returnDialog.addEventListener('click', (e) => {
  if (e.target === returnDialog) returnDialog.close();
});
returnDialog.addEventListener('close', () => { returnDialogOrderId = null; });
```

- [ ] **Step 4: Type-check and verify**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npx astro check 2>&1 | grep -E "shop-client|pro-shop|error ts" | head
```

Expected: no lines for these files.

In the browser: Shop → Orders. Expected: a Ref column with six-character codes; a Return link only on paid, uncancelled rows. Click Return on the Task 3 order → dialog titled `Return — order <REF>`, the single line shows Bought 1, Returnable 0, input disabled with "fully returned". Create and pay a second order (mark it paid via the DB snippet in Task 3 if there's no Stripe locally) with quantity 2, open Return, enter 1, add a reason, Raise return → toast `Return raised — see Enquiries`. Event Inquiries shows the new thread with `Raised by staff` in its panel. Screenshot the Orders dialog and the return dialog for layout problems.

- [ ] **Step 5: Commit**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git add src/pages/pro-shop.astro src/scripts/shop-client.ts && git commit -m "Add a Reference column and staff-raised returns to the Orders dialog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Returns tab in Settings (dashboard)

**Files:**
- Modify: `src/pages/settings.astro` (tab nav ~13-17; new panel after the Tax panel)
- Modify: `src/scripts/settings-client.ts` (after the Tax section, ~432)

**Interfaces:**
- Consumes: `return_instructions` on `GET`/`PUT /api/property/me` (Task 4).

- [ ] **Step 1: Markup**

In the tab nav, after the Tax button:

```html
      <button type="button" class="settings-tab" role="tab" data-tab-target="returns">Returns</button>
```

After the Tax panel's closing `</div>` add:

```html
    <div class="chart-card settings-card" data-settings-tab="returns" hidden>
      <h2>Returns</h2>
      <div class="chart-card-header">
        <p class="chart-card-subtitle">Sent to guests when they request a shop return, and used by AI replies on return enquiries. Where to send items, deadlines, how refunds are handled.</p>
      </div>
      <form id="returns-form" class="settings-form">
        <label for="return-instructions">
          Return instructions
          <textarea id="return-instructions" rows="6" maxlength="4000" placeholder="Post items to … quoting your order reference, within 30 days. Refunds go to the original card once we've received them."></textarea>
        </label>
        <button id="return-instructions-save" type="submit">Save</button>
      </form>
    </div>
```

- [ ] **Step 2: Client**

After `loadTaxSettings();` add:

```ts
// ── Returns ──────────────

const returnInstructionsInput = document.getElementById('return-instructions') as HTMLTextAreaElement;
const returnsForm = document.getElementById('returns-form') as HTMLFormElement;
const returnInstructionsSaveBtn = document.getElementById('return-instructions-save') as HTMLButtonElement;

returnsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  returnInstructionsSaveBtn.disabled = true;
  try {
    const res = await apiFetch('/api/property/me', {
      method: 'PUT',
      // Empty clears it (null) -- the API treats undefined as "unchanged".
      body: JSON.stringify({ return_instructions: returnInstructionsInput.value.trim() || null }),
      signal: AbortSignal.timeout(15000),
    });
    const updated = await res.json().catch(() => null);
    if (!res.ok || !updated) {
      showToast(`Failed to save — ${updated?.error ?? 'unknown error'}`, 'error');
      return;
    }
    returnInstructionsInput.value = updated.return_instructions ?? '';
    showToast('Return instructions saved', 'success');
  } catch {
    showToast('Failed to save', 'error');
  } finally {
    returnInstructionsSaveBtn.disabled = false;
  }
});

async function loadReturnSettings() {
  const res = await apiFetch('/api/property/me').catch(() => null);
  const settings: { return_instructions?: string | null } | null = res?.ok ? await res.json().catch(() => null) : null;
  if (!settings) return; // loadTaxSettings already toasted for the same request failing
  returnInstructionsInput.value = settings.return_instructions ?? '';
}

loadReturnSettings();
```

- [ ] **Step 3: Type-check and verify**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && npx astro check 2>&1 | grep -E "settings|error ts" | head
```

Expected: no lines for `settings-client.ts` / `settings.astro`.

In the browser: Settings → Returns. Expected: the textarea shows the text set in Task 4. Edit it, Save → toast `Return instructions saved`; reload → the edit persists; `#returns` in the URL opens the tab directly. Screenshot for layout.

- [ ] **Step 4: Commit**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git add src/pages/settings.astro src/scripts/settings-client.ts && git commit -m "Add a Returns tab for return instructions in Settings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: End-to-end pass and push (both repos)

**Files:** none new. This task runs the spec's checklist against the finished build.

- [ ] **Step 1: First-reply matrix**

For each AI mode, raise a fresh guest-shape return (curl from Task 7 against a newly paid order) and check the thread with the replies curl from Task 7:

| set `ai_reply_mode` to | expect on the thread |
|---|---|
| `auto` (score ≥ threshold, tokens available) | one outbound with `ai_draft_id` set, no plain acknowledgement |
| `draft` | one outbound plain acknowledgement; a pending AI draft is visible in the reply dialog |
| `off` | one outbound plain acknowledgement only |

Change the mode with `PUT /api/property/ai-replies` (Clerk token; use the dashboard's AI Replies tab). Never two outbound messages on a fresh thread.

- [ ] **Step 2: Zero-token behaviour**

Set the property's `token_balance` to 0 directly in the local DB, raise a return. Expected: the server logs `AI reply skipped ... insufficient tokens`, the forward to `fallback_email` fires if one is set, AND the guest acknowledgement is still recorded as the single outbound message. Restore the balance afterwards.

- [ ] **Step 3: Stock restore**

Pick a return whose item has `stock_quantity` tracked. Note the item's stock (`GET /api/proshop/items`), move the return `approved → received`, re-read the stock. Expected: increased by the returned quantity. Move it `received → refunded`, then attempt `refunded → cancelled`. Expected: `409`.

- [ ] **Step 4: General enquiries unaffected**

Create a plain enquiry through `POST /api/event-inquiries` and open it in the dashboard. Expected: date/guests/time fields, Convert to booking visible, `return: null` in the list payload, AI draft unaffected.

- [ ] **Step 5: Push the dashboard**

```bash
cd /c/Users/robert/source/repos/ota-table-bookings && git log --oneline -3 && git push
```

- [ ] **Step 6: Record what's live**

Tell Robert: the migration was applied to both DBs, which OTA commit range shipped, that Willy T (and any other site) can now use `POST /api/proshop/orders/lookup` and `POST /api/proshop/returns` with reference + email, and that the follow-ups in the spec (Stripe refund, Returns page, website flow) remain open.
