# Pro shop stock: one catalogue, real/digital shops, a stock ledger

Project 1 of 3 harvested from Mobilist (`C:\Users\robert\source\Workspaces\Mobilist\booking-schema-poc`,
`db/schema.ts` + `src/lib/db/warehouseStock.ts`):

1. **Catalogue + stock (this doc)**
2. Warehouse: warehouses, bins, goods-in, pick/pack, cycle counts, barcode labels, cross-org warehouse↔shop links
3. Delivery: routes, vehicles, drivers, proof of delivery, guest tracking, route optimisation

Each is designed after the previous one ships. This doc must not build 2 or 3, but must not block them either.

## Why

Today stock is one nullable `proshop_item.stock_quantity` per item, shared by counter/tee-sheet sales, website
orders and AI-agent orders. It has no history (no who/why), it can oversell (the 409 check happens before the
write, the `GREATEST(…, 0)` clamp then hides the oversell), and cancelling a paid order with a received return
over-counts stock (`proshop.js` `updateOrder`). The user wants OTA to be the single system for selling *and*
holding stock — "less talk" between systems — so the warehouse lives in OTA rather than integrating with
Mobilist.

## Decided with the user

- **Build it in OTA.** No Mobilist integration. Mobilist is source material only (its data model and flows,
  rewritten in OTA's Express + `pg` style).
- **Shops have a type: real or digital.** A real shop (pro shop counter, tee-sheet add-ons) sells from its own
  shelf stock. A digital shop (website, AI agents) sells from its own stock — in project 2 that becomes a
  linked warehouse.
- **Shop stock and warehouse/digital stock are separate.** They never pool.
- **A product is edited in one place.** One catalogue per property: name, category, price, sale price, variants.
  Shops sell from it; stock is the only per-place thing.
- **OTA is backend only.** Staff screens are built later in the staff dashboard's own repo against these
  endpoints.
- **Collect-in-store vs ship is the booking website's decision**, including shipping rules (e.g. a St Barts shop
  that only ships to the USA). OTA supplies stock facts per place and enforces them; it stores no shipping rules
  (consistent with the "OTA holds minimal data" rule — `shipping_cost` is already trusted as sent).
- **An order can be split** into fulfilments (some lines collected at a real shop, the rest shipped) — the
  website works out the split.

## Goals

- Every stock change is an append-only movement with a reason, a place, who did it and what caused it.
- Selling can never silently oversell through OTA's own checkout: the check and the reservation happen
  atomically.
- Real and digital shops keep separate stock for the same catalogue product.
- Staff can receive stock, adjust/set a count, and move stock between shops of the same property.
- Existing websites, the dashboard Items dialog, tee-sheet sales and the agentic feed/orders keep working
  without changes on their side.

## Non-goals

- Warehouses, bins, pick/pack, cycle counts, labels, cross-org links (project 2).
- Routes, drivers, tracking (project 3).
- Shipping rules, shipping regions, carrier rates (the website's job).
- Per-shop prices. One price per product everywhere.
- Any UI.

## Anti-goals (would be a failure even if it works)

- An existing website or the tee sheet breaks or needs a change to keep selling.
- Stock history that can be edited or deleted.
- The ledger keyed in a way project 2 has to re-key (e.g. stock keyed on `shop_id` directly).
- Shipping/collection policy creeping into OTA.

## Design

### Data model (new migration `src/db/migrate-2026-10-16-proshop-stock-ledger.sql`, mirrored into `schema.sql`)

**`shop.type`** — `VARCHAR(10) NOT NULL DEFAULT 'real'`, CHECK `IN ('real','digital')`. All existing shops
become `real`. Settable on `POST/PUT /api/proshop/shops`.

**`proshop_item`** stays the catalogue product (property-scoped, unchanged price/variant/sale columns).
- `shop_id` is kept and re-meant as the item's **home shop**: the default stock place for legacy callers that
  don't say which shop (tee-sheet sales, the Items dialog's `stock_quantity`). Builder's call whether to rename
  it; the API field name must stay `shop_id`.
- New `stock_tracked BOOLEAN NOT NULL DEFAULT false`. Migration sets it `true` where `stock_quantity IS NOT
  NULL`. Untracked items are never checked, reserved or moved — today's "NULL = unlimited" behaviour.
- `stock_quantity` column is dropped after the backfill (it becomes a computed response field, see below).

**`shop_item`** `(shop_id, item_id)` PK — which shops sell which products. Migration inserts one row per item
for its current `shop_id`. Absent row = that shop doesn't sell it. (User's guess-confirmed default: each shop
can carry a subset.)

**`stock_location`** — the place stock is held.
`id UUID PK, property_id UUID NOT NULL, shop_id UUID NULL REFERENCES shop(id), name VARCHAR(100), created_at`.
In this project every shop gets exactly one location (`shop_id` set, UNIQUE on `shop_id`), created with the
shop. Project 2 adds warehouse bins as further rows (`shop_id NULL`, plus its own columns). The ledger and
balances reference `stock_location`, never `shop`, so project 2 doesn't re-key anything.

**`stock_balance`** `(location_id, item_id)` PK, `on_hand INT NOT NULL DEFAULT 0`, `updated_at`. Running total
of the ledger — always equal to `SUM(delta)` of its movements. **No `>= 0` check**: on_hand can go negative
(see agent orders); negative = oversold.

**`stock_movement`** — append-only, never updated or deleted.
`id UUID PK, property_id, location_id, item_id, delta INT NOT NULL CHECK (delta <> 0), reason VARCHAR(20) NOT
NULL, order_fulfilment_id UUID NULL, golf_booking_item_id UUID NULL (no FK — booking items are hard-deleted),
return_id UUID NULL, transfer_id UUID NULL (pairs the two halves of a move), note TEXT NULL, performed_by
VARCHAR(100) NULL (Clerk user id; NULL for guest/agent/system), created_at TIMESTAMPTZ DEFAULT now()`.
Index `(location_id, item_id, created_at)`.
Reasons: `opening`, `received`, `adjusted`, `transferred`, `sold`, `sale_reversed`, `returned`.

**`proshop_order_fulfilment`**
`id UUID PK, order_id UUID NOT NULL REFERENCES proshop_order ON DELETE CASCADE, method VARCHAR(10) NOT NULL
CHECK IN ('collect','ship'), location_id UUID NOT NULL REFERENCES stock_location`.
**`proshop_order_item.fulfilment_id`** UUID NOT NULL after backfill. Migration gives every existing order one
fulfilment (`ship` if `shipping_address` set, else `collect`; location = the order's shop's location).
No fulfilment status in this project — project 2 adds pick/pack status.

**Backfill**: one location per existing shop. Items with `shop_id IS NULL` get the property's first active
shop by name as home shop (the agentic rule); a property with such items and no shop at all gets a `real`
shop named "Pro Shop" created for them. Then for each tracked item, a balance at its home shop's location
with `on_hand = stock_quantity` and one `opening` movement (`performed_by NULL`, note `'migrated from
stock_quantity'`). Migration is idempotent (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING`), run once on live like
the other `migrate-*.sql` files.

### Stock arithmetic

- **on_hand** (per location, item) = the balance row.
- **held** = sum of line quantities on fulfilments at that location whose order is `pending` (unpaid, not
  cancelled) and was created less than **30 minutes** ago. Computed on read — no expiry job. (My call: a
  website creates the order from the cart before the payment form; abandoned carts stop holding stock after 30
  minutes without anything having to run.)
- **available** = on_hand − held. This is what every "in stock / only N left" uses.

Paid orders don't hold — their stock has already left on_hand as a `sold` movement. (Project 2 changes ship
fulfilments to stay reserved until picked; that's why reservations hang off fulfilments.)

### One helper, all writers

`src/lib/stock.js`, every function takes the caller's transaction client:

- `applyMovement(client, { propertyId, locationId, itemId, delta, reason, …refs, performedBy })` — inserts the
  movement and upserts the balance in one atomic statement
  (`INSERT … ON CONFLICT (location_id, item_id) DO UPDATE SET on_hand = stock_balance.on_hand + EXCLUDED.on_hand
  RETURNING on_hand`). Never read-then-write — that's the Mobilist bug not to copy.
- `lockAndCheck(client, locationId, lines)` — locks the balance rows for the requested (location, item) pairs
  `FOR UPDATE` in a stable order (sorted by item id, avoids deadlocks; insert missing rows at 0 first so there's
  something to lock), computes available, returns the first short line or null.
- `availability(db, propertyId, locationIds, itemIds?)` — on_hand/held/available for reads.
- Untracked items are filtered out up front by every function.

All existing `UPDATE proshop_item SET stock_quantity …` statements are replaced by these.

### Selling paths

| Path | Today | New |
|---|---|---|
| Website `POST /orders` | checks `stock_quantity`, no hold | Builds fulfilments (below); in its existing transaction, `lockAndCheck` per fulfilment location; short → 409 `Only N of "X" available at <shop>`, rollback. Success holds the stock via the pending order. |
| Any change of `proshop_order.status` (confirm-payment, the payment-intent already-succeeded branch, staff `PUT /orders/:id`) | Stripe paths decrement after a non-transactional "already paid?" read; staff marking paid at the till decrements **nothing** (bug) | **Stock follows `status`, not `payment_status`.** One shared function, one transaction: `UPDATE proshop_order SET status=$new … WHERE id=$1 AND status=$old RETURNING *` (0 rows → 409 "order changed, reload", or for the Stripe paths a harmless no-op). **Entering `paid`** from anything → `sold` movements per tracked line from its fulfilment's location. **Leaving `paid`** to anything → `sale_reversed` of (ordered − net returned, see returns) per line. Every other move (pending↔cancelled) touches no movements — pending only holds. This makes `on_hand = SUM(delta)` hold over any sequence of moves, including pending→paid→pending→paid, and closes the double-decrement race. `payment_status` keeps meaning "Stripe confirmed it" and is unchanged. No availability re-check on entering `paid` — money is already taken; if the hold had expired and stock ran out, on_hand goes negative and shows as oversold. |
| Return `approved → received` | restore qty | `returned` +qty movement (with `return_id`) into the line's fulfilment location. |
| Return `received → cancelled` | stock left restored | `returned` −qty movement (same `return_id`) — the goods go back out to the guest. Staff `adjust` if they actually stayed. `received → refunded` touches no stock. |

"Net returned" per order line = `SUM(delta)` of `returned` movements for that line's returns — read from the
ledger, never from return statuses, so it's right whatever path the return took.
| Tee-sheet `POST /booking/:id` | check + clamped decrement, not atomic | Optional body `shop_id` (must be a `real` shop selling the item), default = item's home shop. One transaction: `lockAndCheck`, 409 if short, insert booking item, `sold` movement with `golf_booking_item_id`. |
| Tee-sheet `DELETE /booking/:id/:item` | restore | `sale_reversed` to the location the `sold` movement used (look it up by `golf_booking_item_id`). Pre-migration booking items have no `sold` movement; their sale was already folded into the `opening` balance, so reverse to the item's home shop if it's tracked. |
| Agent orders (`agenticOrders.recordOrder`) | clamped decrement in-transaction | Shop = `property.agentic_commerce.shop_id` if set, else today's rule (first active shop by name). **Never switches automatically** when a digital shop is created — the venue sets `shop_id` once that shop has its products linked and stock transferred. One `ship`/`collect` fulfilment (by address, as the backfill). `sold` movements; **no check** — the agent already took payment, so on_hand may go negative (oversold). |

**Order request shape** (`POST /api/proshop/orders`), additive:
```json
{ "shop_id": "<digital shop>", "items": [...], "fulfilments": [
  { "method": "collect", "shop_id": "<real shop>", "items": [{ "item_id": "...", "quantity": 1 }] },
  { "method": "ship", "items": [{ "item_id": "...", "quantity": 2 }] }
] }
```
- `fulfilments` omitted → today's behaviour: one fulfilment from `items`, `ship` if `shipping_address` else
  `collect`, location = `shop_id`'s.
- `fulfilments` given → `items` is ignored (builder's call: reject if both sent). A fulfilment's `shop_id`
  defaults to the order's `shop_id`; it must belong to the property and sell every item in it. The same
  item may appear in two fulfilments (split quantity). Pricing is unchanged: per line, from the catalogue.
- OTA does not validate the website's method choice (e.g. it doesn't require a shipping address for `ship`) —
  that's website policy. It only enforces stock.
- Responses include `fulfilments: [{ id, method, shop_id, items }]` on create/get/list.

### Reading stock

- `GET /api/proshop/items?shop_id=X` (existing): unchanged shape. Filters via `shop_item`. Each item's
  `stock_quantity` is now **available at X's location** (null if untracked) — so current websites see the right
  number with no change. Without `shop_id`, `stock_quantity` is available summed over the property's shop
  locations (builder's call to document it as such).
- New `GET /api/proshop/stock?shop_id=&item_id=` → `[{ shop_id, item_id, on_hand, held, available }]` for
  tracked items. API key or staff. This is what a website calls to decide collect vs ship across shops.
- New `GET /api/proshop/stock/oversold` (staff) → rows where on_hand < 0 or available < 0.
- New `GET /api/proshop/stock/movements?shop_id=&item_id=&cursor=&limit=` (staff) → the ledger, newest first,
  same cursor/limit convention as `listOrders`.
- Agentic feed (`agenticFeed.js`) uses the same agent shop as agent orders: lists only items that shop sells
  (`shop_item`) and reads available at its location instead of `stock_quantity`. Until `agentic_commerce.shop_id`
  is set this is the same shop as today, so WillyT's feed doesn't change.

### Rollout for a venue going digital

Nothing changes for a venue until staff act: (1) create a `digital` shop, (2) link products to it
(`PUT /items/:id/shops`), (3) `transfer` stock into it, (4) point the website's `shop_id` and
`agentic_commerce.shop_id` at it. Steps 1–3 are invisible to guests.

### Staff stock actions (Clerk bearer only — reject `auth_method === 'api_key'` with 403)

- `POST /api/proshop/stock/receive` `{ shop_id, item_id, quantity > 0, note? }` → `received`.
- `POST /api/proshop/stock/adjust` `{ shop_id, item_id, set_to >= 0 | delta ≠ 0, note? }` → `adjusted` with
  delta = set_to − on_hand (locked); no-op if zero. Also how staff correct oversold stock.
- `POST /api/proshop/stock/transfer` `{ from_shop_id, to_shop_id, item_id, quantity > 0, note? }` → two
  `transferred` movements sharing a `transfer_id`; 409 if from's available is short.
- All three: item must be tracked (409 otherwise); shops must be in the property.

### Catalogue endpoints

- `POST /items` `{ …, shop_id, stock_quantity? }`: creates the product, a `shop_item` row for `shop_id`; a
  number in `stock_quantity` → `stock_tracked = true` + an `opening` movement at that shop. Null/omitted =
  untracked.
- `PUT /items/:id` `stock_quantity`: number → tracked, `adjusted` (set_to) at the home shop; `null` →
  untracked (balances and history kept, just ignored). Keeps the dashboard Items dialog working.
- New `PUT /items/:id/shops` `{ shop_ids: [...] }` (staff) replaces which shops sell the product.
- Shop create also creates its `stock_location`.

### Docs

`src/docs/swagger.js` updated for every changed/new endpoint and the new response fields.

## Constraints

- Node/Express + `pg`, raw SQL, the existing controller style; errors through `next(err)`, JSON `{ error }`.
- Every selling path's check + write in one transaction (`pool.connect()` + `BEGIN`, as `createOrder` does).
- Property scoping on every query (`req.property_id`).
- No test framework exists in the repo. Leave one runnable check: a `node` script (e.g.
  `scripts/check-stock-ledger.js`) against a dev DB that exercises reserve → pay → cancel → return and asserts
  balance = `SUM(delta)` and no double-decrement on a repeated confirm.
- Live rollout like other modules: run the migration on live before pushing main (pushing auto-deploys to
  Render). The migration must be additive until the backfill completes; the `stock_quantity` drop goes last,
  in the same file, after the backfill.

## Calls I made (user to check)

- 30-minute hold for unpaid orders, computed on read.
- Agent orders may push stock negative; surfaced via `/stock/oversold` instead of being clamped to 0.
- `proshop_item.shop_id` kept as "home shop" for legacy callers rather than removed.
- Per-shop product on/off (`shop_item`), migrated so every item stays in its current shop only.
- Staff-only stock actions; transfers included now because separate real/digital stock needs them from day one.
- Returns go back to the fulfilment's location.
- No fulfilment status yet (deferred to project 2's pick/pack).
- Stock follows order `status` (any path into/out of `paid`), which also fixes staff till-paid orders never
  taking stock today.
- Agent orders/feed move to a digital shop only via an explicit `agentic_commerce.shop_id`.
- Items with no shop get the first active shop (or a new "Pro Shop") as home during the migration.
- A received return that's then cancelled takes its stock back out.

## Left to the builder

Exact SQL/index names, file split between `controllers/proshop.js` and a new `controllers/stock.js`, error
message wording, response field ordering, and the check script's shape.
