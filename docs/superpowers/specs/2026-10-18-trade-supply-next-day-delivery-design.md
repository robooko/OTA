# Trade supply: next-day delivery orders for a food supplier (general spec)

**Status: general draft, to be updated when a real supplier is lined up.** Written for the generic case of a
butcher / hospitality food supplier: restaurants, hotels and cafés order today, and the supplier cuts, packs
and delivers tomorrow in booked delivery slots. Anything marked *(my call)* is a default the user hasn't
confirmed. "Open questions" at the end lists what a real customer has to answer before planning.

## Why

The pro shop stock ledger spec (`2026-10-16-proshop-stock-ledger-design.md`, project 1 of 3, not built yet)
plans one catalogue, stock per location and an append-only ledger. Projects 2 (warehouse) and 3 (delivery)
come from Mobilist. A food supplier needs most of 2 and 3, but in a different order and shape than a pro shop:

- the customer is a **business with an account**, not a guest at checkout
- orders are for **tomorrow**, with an **order cutoff**, into **delivery slots** with limited capacity
- meat is sold by weight, and the **packed weight differs from the ordered weight** (catch-weight)
- food safety needs **lot / use-by traceability**: which customers got which batch

OTA already has the hard parts in other forms: slots with capacity seeded from a timetable (tours, tee
times, equipment windows), atomic reserve-on-order (the planned ledger), Stripe, QuickBooks per org, SMS/AI
receptionist, and multi-property per org. This spec adds a trade module that puts those together.

## Goals

- A trade customer (or staff on their behalf) can place an order for a delivery date and slot, and edit it
  until the cutoff.
- A slot can never be overbooked (drops and/or weight), with the check and booking in one transaction.
- Orders past the cutoff are locked and roll into a **cutting/pick list** per delivery date.
- Packers record actual weights and lots; the invoice and the card charge use **actual** weights.
- Any lot can be traced to every order and customer it went to (recall).
- Staff see a day's deliveries grouped by slot/zone, in stop order, and record delivered / failed with
  proof of delivery.
- On-account customers get invoiced into QuickBooks; card customers are charged the actual total.

## Non-goals (for this version)

- Route optimisation, live driver tracking, a driver app (Mobilist project 3; revisit after v1).
- Bins, cycle counts, barcode labels (project 2).
- Carcass breakdown / yield / production costing.
- Temperature logging and HACCP records.
- Customer-facing ordering website or app (OTA is backend only; the supplier's site or the staff dashboard
  calls these endpoints).
- Delivery charges by distance. A flat per-slot or per-zone fee is enough for v1 *(my call)*.

## Anti-goals (a failure even if it works)

- A slot takes more drops or kg than its capacity.
- A customer is charged the estimated weight rather than what was packed.
- A lot can't be traced to the orders it went into.
- An order changes after cutoff without staff doing it on purpose (and that change being recorded).
- The pro shop / tee sheet / agentic paths break or slow down because the shared ledger changed.

## Design

### Where it lives

A new module `trade` (`enabled_modules` key `trade`), property-scoped like every module: the property is the
supplier's depot. Routes under `/api/trade`, controllers `src/controllers/trade*.js`, helpers in
`src/lib/trade*.js`. Same auth as other modules: staff via Clerk bearer, the supplier's ordering site via
API key.

**Minimal-data note.** OTA normally holds as little as possible and lets the calling site own its data. Trade
accounts are an exception: no other system owns them, and slots, credit and invoicing need them server-side.
Keep to what ordering, delivery and invoicing actually use. No CRM fields *(my call)*.

### Catalogue and stock (amends the stock ledger spec)

Reuse the planned `proshop_item` catalogue and stock ledger rather than a second catalogue. Because that
spec isn't built yet, fold these into it **before** it is built, so nothing has to be re-keyed later:

- **Decimal quantities.** `stock_balance.on_hand`, `stock_movement.delta` and order line quantities become
  `NUMERIC(12,3)` instead of `INT`. The pro shop keeps whole numbers by validation, not by column type.
- **Sell unit per item.** `sell_unit VARCHAR(10) NOT NULL DEFAULT 'each'`, CHECK `IN ('each','kg')`.
  - `each` + `catch_weight = true`: sold per piece (e.g. "4 × ribeye ~300g"), priced per kg, with
    `nominal_weight_kg` used for the estimate. Stock is tracked in kg.
  - `kg`: ordered and priced by weight directly (e.g. "5 kg mince").
  - `each` + `catch_weight = false`: plain fixed-price item (e.g. a jar of stock), as the pro shop.
- **Lots.** New `stock_lot (id, property_id, item_id, code, received_at, use_by DATE, supplier_ref, note)`.
  `stock_movement.lot_id UUID NULL` and `stock_balance` gains `lot_id` in its key for lot-tracked items
  (`lot_tracked BOOLEAN DEFAULT false` on the item). Untracked items work exactly as the stock spec says.
- **Reserve vs sell.** A trade order holds stock (like the stock spec's pending hold) from placement until
  packed, with no 30-minute expiry, because the order is committed. Packing posts the `sold` movements at
  actual weight against the chosen lot(s).

### Trade customers

- `trade_account (id, property_id, name, status active/on_hold/closed, payment_terms 'card'|'account',
  credit_limit NUMERIC NULL, terms_days INT NULL, qbo_customer_id NULL, notes, created_at)`.
- `trade_contact (id, account_id, name, email, phone, can_order BOOLEAN)`: who may place orders. Ordering
  by phone or SMS identifies the contact by number.
- `trade_site (id, account_id, name, address JSONB, zone_id, delivery_notes, access_window_from/to TIME
  NULL)`: delivery address. An account can have several (a hotel group's kitchens).
- **Prices:** list price from the catalogue, plus an optional `trade_price (account_id, item_id, price)`
  override per account. Trade suppliers almost always negotiate per customer *(my call to include it in v1;
  price tiers can come later)*.
- **On hold / over credit:** on-account orders are refused (409) if the account is `on_hold`, or if the
  open balance plus this order's estimate passes `credit_limit`.

### Zones, slots and the cutoff

Modelled on tour slots: a weekly template seeded out to a horizon, so staff only manage exceptions.

- `delivery_zone (id, property_id, name, active)`: an area a van covers, such as "City centre" or "Coast".
  Sites are assigned a zone by staff. No geocoding in v1 *(my call)*.
- `delivery_slot_template (id, property_id, zone_id, weekdays INT[], window_start TIME, window_end TIME,
  max_drops INT NULL, max_kg NUMERIC NULL, cutoff_days_before INT DEFAULT 1, cutoff_time TIME DEFAULT
  '16:00', fee NUMERIC DEFAULT 0, active)`.
- `delivery_slot (id, property_id, zone_id, template_id NULL, date, window_start, window_end, max_drops,
  max_kg, cutoff_at TIMESTAMPTZ, fee, status active/closed, is_extra)`, UNIQUE `(zone_id, date,
  window_start)`. Seeded like `tourSlotSeeder.js` with ON CONFLICT DO NOTHING. Staff can close a slot,
  change its capacity, or add extra ones.
- **Cutoff** is stored per slot as an absolute `cutoff_at`, computed in the property's timezone at seeding.
  Bank holidays are handled by staff closing or moving slots, not by a holiday calendar *(my call)*.
- **Capacity check.** Booking an order into a slot locks the slot row `FOR UPDATE`, sums drops (distinct
  sites with a non-cancelled order in that slot) and estimated kg, and returns 409 `Slot full` if either
  limit would be exceeded. A second order from the **same site** in the same slot doesn't use another drop.
- `GET /api/trade/slots?site_id=&from=&to=` returns slots for the site's zone, with remaining drops/kg and
  whether the cutoff has passed.

### Orders

`trade_order (id, property_id, account_id, site_id, contact_id NULL, slot_id, delivery_date, status,
reference, po_number NULL, notes, estimated_total, final_total NULL, payment_terms, stripe_payment_intent_id
NULL, qbo_invoice_id NULL, placed_via 'staff'|'api'|'sms'|'standing', created_at, locked_at, packed_at,
delivered_at)`.

`trade_order_line (id, order_id, item_id, ordered_qty NUMERIC, ordered_unit 'each'|'kg', unit_price
(per kg or each), estimated_kg NULL, packed_kg NULL, packed_qty NULL, line_total_estimated, line_total_final
NULL, substitution_of NULL, note)`.

**Status flow:**
`placed` → (`cutoff_at` passes) `locked` → `picking` → `packed` → `out_for_delivery` → `delivered` |
`failed`. Any status before `out_for_delivery` can move to `cancelled` (staff after cutoff; customer before).

- **Before cutoff:** the customer/API can edit lines, change slot (re-runs the capacity check) or cancel.
- **After cutoff:** only staff can change it, and every change after the lock is recorded in
  `trade_order_event (order_id, at, by, kind, detail JSONB)`.
- **Locking** happens on read, not by a job: any order whose slot `cutoff_at` has passed is treated as
  locked, and the first staff list call stamps `locked_at` *(my call, matching the stock spec's
  computed-on-read hold)*.
- **Short stock at order time:** 409 per line, as in the stock spec. Staff can override with a forced line
  that goes negative, shown as oversold. A butcher often cuts to order, so v1 allows a per-item
  `allow_backorder` flag where stock isn't checked at order time at all *(my call; see open questions)*.

### Catch-weight pricing and payment

- At order: `estimated_kg = ordered_qty × nominal_weight_kg` (or the ordered kg). The estimated total is shown
  as "approx".
- At pack: staff enter `packed_kg` per line (typed or from a scale later) and the lot(s) used.
  `line_total_final = packed_kg × unit_price` for catch-weight lines. The order's `final_total` = lines + slot
  fee + tax (existing `src/lib/tax.js`).
- **Card customers:** a Stripe PaymentIntent with manual capture authorises `estimated_total × (1 +
  tolerance)` when the order locks (tolerance per property, default 15% *(my call)*), then captures
  `final_total` at `packed`. If the final total is over the authorised amount, capture what was authorised
  and flag the difference for staff. Next-day delivery stays inside Stripe's 7-day authorisation window.
- **On-account customers:** at `delivered`, push an invoice to QuickBooks for `final_total` (per-org QBO
  connection already exists), customer = `qbo_customer_id`. Payment is tracked in QBO; OTA only stores
  `qbo_invoice_id`.
- **Substitutions / shortages:** the packer can mark a line short (pack less, or zero) or substitute another
  item (a new line with `substitution_of`). The customer gets one notification at `packed` listing the
  changes.

### Cutting list and pick list

- `GET /api/trade/production?date=` returns tomorrow's (or any date's) totals per item: ordered units and
  estimated kg, across all non-cancelled orders. This is the butcher's cutting list.
- `GET /api/trade/picklist?date=&slot_id=&zone_id=` returns orders grouped by slot then site, with lines,
  delivery notes and site access window. Printable by the dashboard.
- `POST /api/trade/orders/:id/pack` `{ lines: [{ line_id, packed_kg?, packed_qty?, lot_ids: [...] }] }`
  records weights and lots, posts `sold` movements at actual quantity per lot, sets `packed`, captures
  payment.

### Deliveries

- Day view: `GET /api/trade/deliveries?date=` returns slots, then stops (one per site per slot), in
  `stop_seq` order (set by staff, default by site name). No optimisation in v1.
- `PUT /api/trade/deliveries/:slot_id/sequence` sets stop order and an optional `driver_name` / `vehicle`
  label *(my call: plain text, no driver/vehicle tables until project 3)*.
- `POST /api/trade/orders/:id/deliver` `{ outcome: 'delivered'|'failed', signed_by?, photo?, note? }`. A
  photo goes through per-org storage as other uploads do. `failed` keeps stock out (it was packed) and
  staff decide: re-slot (a new slot booking, no capacity bypass) or return to stock (`returned` movement).
- Notifications (email via Resend, SMS via Twilio, both existing): order confirmed, changes at pack,
  out for delivery, delivered.

### Standing orders

`trade_standing_order (id, account_id, site_id, weekdays INT[], slot_template_id, lines JSONB, active,
skip_dates DATE[])`. A seeder creates the next `placed` order for each matching date when its slot is seeded,
or N days ahead *(my call: 7)*. It uses the normal capacity and stock checks. A failure makes no order and
notifies staff and the contact. Customers edit the generated order like any other before cutoff.

### Ordering by text (later, cheap)

The AI receptionist already answers texts on the property's number (e39888e). A `trade` tool set
("what's in my order for tomorrow", "add 2 kg mince") for known contacts' numbers is a natural phase 2. It
uses the same endpoints and rules and is called out here so the v1 API shape suits it. Not in v1.

### Traceability

- `GET /api/trade/lots/:lot_id/trace` returns every movement of the lot, with order, account, site and
  delivery date for sold lines. This is the recall report.
- `GET /api/trade/lots?item_id=&expiring_before=` lists lots and use-by dates.
- Packing refuses a lot past its `use_by` before the delivery date (409, staff override recorded as an
  event).

### Endpoints summary

| Area | Endpoints |
|---|---|
| Accounts | `GET/POST/PUT /accounts`, `/accounts/:id/contacts`, `/accounts/:id/sites`, `/accounts/:id/prices` |
| Zones & slots | `GET/POST/PUT /zones`, `/slot-templates`, `GET /slots`, `PUT /slots/:id` (close/capacity), `POST /slots` (extra) |
| Orders | `GET/POST /orders`, `GET/PUT /orders/:id`, `POST /orders/:id/cancel`, `/pack`, `/dispatch`, `/deliver` |
| Standing | `GET/POST/PUT/DELETE /standing-orders` |
| Production | `GET /production`, `GET /picklist`, `GET /deliveries`, `PUT /deliveries/:slot_id/sequence` |
| Lots | `POST /lots` (with goods-in `received` movement), `GET /lots`, `GET /lots/:id/trace` |

All under `/api/trade`. Swagger updated in `src/docs/swagger.js`. API-key callers act for a **contact**
(header or body `contact_id`, validated to the property), and can only see that contact's account.

## Constraints

- Node/Express + `pg`, raw SQL, existing controller style, errors via `next(err)`, JSON `{ error }`.
- Every check+write (slot capacity, stock hold, pack, payment capture) in one transaction. Stripe calls go
  outside the DB transaction with an idempotency key per order and step.
- Property scoping on every query. Times in the property's timezone. Dates as `YYYY-MM-DD`.
- New migration `src/db/migrate-YYYY-MM-DD-trade.sql`, mirrored into `schema.sql`, idempotent, run on live
  before pushing main (main auto-deploys to Render).
- Depends on the stock ledger being built **with the amendments above** (decimal qty, sell unit, lots).
  Either build the ledger first with those changes, or build both together.
- No test framework. Leave one runnable `scripts/check-trade.js` against a dev DB: fill a slot to capacity
  (the next order gets 409), place, then lock at cutoff, then pack with a different weight (final total uses
  packed kg, ledger `SUM(delta)` matches the balance), then trace the lot to the order.

## Phasing *(my call)*

1. Ledger amendments + accounts/sites + zones/slots/cutoff + orders + production/pick list + pack with
   weights. Payment = on-account only, invoiced to QBO.
2. Card payments (auth/capture), standing orders, delivery day view + POD, notifications.
3. Lots and trace (could move to 1 if the first customer needs it for compliance).
4. Ordering by text; later Mobilist project 3 (routes, drivers, optimisation).

## Open questions (for a real customer)

1. Do they cut to order (no stock check at order time) or sell from stock on hand? This decides whether
   `allow_backorder` is the default.
2. Is slot capacity in drops, kg, van count, or a mix? Is it per zone, or one fleet for all zones?
3. Cutoff: one time for everything, or per zone/slot/customer? Same-day top-ups after cutoff?
4. Pricing: per-customer prices, price tiers, weekly market price changes? VAT/IVA rates by product?
5. Payment mix: how many customers pay on account versus by card? Do they already use QuickBooks, or Sage or
   Xero?
6. Traceability: what the regulator actually requires (lot per line, or per carcass/kill number, or
   per supplier delivery), and whether lots must appear on the delivery note.
7. Do they want the customer ordering site built (outside OTA), or will staff key orders from calls and
   WhatsApp at first?
8. Credit control: do orders get blocked automatically on overdue invoices, or does staff decide?

## Left to the builder

Exact table/index names, controller file split, error wording, response field order, the seeder horizon
(reuse 180 days unless slots need fewer), and the check script's shape.
