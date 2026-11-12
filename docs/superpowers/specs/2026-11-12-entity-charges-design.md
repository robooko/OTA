# Charges on every booking

Date: 2026-11-12. Status: design, awaiting approval.

Labels: **(Robert)** = decided by Robert. **(call)** = a default chosen
while writing this; change it if it is wrong.

Companion document: the Hamilton Island site's stay cart,
`C:\Users\robert\source\repos\hamilton-island\docs\superpowers\specs\2026-11-12-stay-cart-design.md`.
The cart takes one card payment for a room plus add-ons and needs somewhere
to record what it took against each add-on. This project is that place, and
is useful to staff on its own.

## Intent

A room booking has a bill: the staff panel shows Charges, Paid and Balance,
and staff can add a charge or take a payment
(`GET /api/bookings/:id/folio`, `src/lib/folio.js`,
`ota-table-bookings/src/scripts/room-bookings-client.ts` `fillCharges`).
Nothing else does. Robert wants every booking to have the same thing.
**"I want all entities to have charges." (Robert)**

## What staff see

On a golf booking, a spa appointment, a restaurant reservation and an
equipment hire, the same block as on a room booking:

- **Charges**: the booking's own price as the first line, then any charges staff added.
- **Paid**: the payments recorded against it, including what a website took.
- **Balance**: charges minus paid.
- **Add charge** and **take payment**, as on a room.

A deposit taken online shows as Paid with a Balance still owing.

## Scope

First: `golf_booking`, `spa_appointment`, `restaurant_reservation`,
`equipment_hire`, the four the cart needs. (call)

Later, same pattern: tours, beach beds, courses. Marina bookings already
have their own pricing and Stripe handling and are left alone. (call)

## Rules

- **Base charge.** Golf and hire use their `total_price`. A spa appointment
  uses the treatment price as frozen at booking (member pricing included).
  A restaurant reservation has no base charge. (call)
- **Restaurant deposits.** A deposit on a reservation with no charges shows
  as Paid with a negative balance, displayed as a credit. Taking that credit
  off the meal's bill (restaurant orders, table sessions) is not part of
  this project. (call)
- **One place per charge.** A spa appointment already linked to a stay
  (`spa_appointment.booking_id`, set by the import) is carried on that
  room's folio. Its own block then says it is charged to the room and shows
  no balance of its own. Nothing is ever owed in two places. (call)
- **Spa's existing money features keep working.** `payment_status`,
  `spaPayments.js`, and the guest bill / invoice routes
  (`/api/spa/:spa_id/bills`) read from the same data as the new block. There
  is one record of what a spa appointment owes, not two. (call)
- **One card payment can pay several bookings.** The cart takes one Stripe
  PaymentIntent and records a payment against each booking it covers, all
  carrying the same intent id. Recording a payment must not require the
  intent id to be unique.
- **Website payments are records.** The Hamilton site charges on its own
  Stripe key and tells OTA what was paid (as `/api/payments` is used for
  rooms today). OTA does not try to refund such a payment through Stripe.
  Refunds of website-taken deposits are not part of this project. (call)
- **Cancelling.** Cancelling a booking leaves its payments on record so
  staff can see what was taken. No automatic refund is added. Existing
  refund behaviour (for example a restaurant reservation cancel refunding
  its own intent) is unchanged for bookings made the existing way. (call)

## Deposit rules

OTA decides what is due at booking, so a website and the front desk agree.
A website never computes a deposit itself.

- **Restaurant.** `payment_protection` (`none` / `hold` / `deposit`) and
  `payment_protection_amount` exist. New: whether the amount is **per guest
  or per table**, chosen per restaurant. (Robert)
- **Spa.** New per-spa setting: no payment, a deposit amount, or full
  payment at booking. (Robert)
- **Golf and equipment hire.** A rule per course and per equipment item:
  no payment or full payment (see "Enforcement"). (call)
- OTA exposes the amount due now for a prospective booking of each kind
  (venue, date, party or quantity), so a caller can show and charge it. (call)
- Both new settings are editable in the staff app where the restaurant and
  spa are configured.

## Found in the code (2026-11-12)

- `payment.booking_id` and `folio_adjustment.booking_id` are `NOT NULL`
  references to `booking`. Both need to be able to belong to another kind
  of booking.
- `golf_booking` and `equipment_hire` have `total_price` and no payment
  fields. `spa_appointment` has `payment_status` (`unpaid` / `paid`),
  `paid_at`, `stripe_payment_intent_id`, `payment_method`.
  `restaurant_reservation` has `stripe_payment_intent_id`, uniquely indexed.
- `computeFolio` already pulls stay-linked spa appointments onto the room's
  folio.
- The staff app is `C:\Users\robert\source\repos\ota-table-bookings`
  (Astro; `golf-bookings-client.ts`, `equipment-hires-client.ts`,
  `reservations-client.ts`, `spa-booking-actions.ts`, `spa-bills.ts`).
  `fillCharges` in `room-bookings-client.ts` is the block to share.
- The MCP server (`mcp-server/tools.js`) mirrors the API; new routes get tools.

## Reviewer pass (2026-11-12)

Answered by the code:

- **"Take payment" on a room is a manual record.** The staff app posts to
  `/api/payments` with a method and `status: 'completed'`
  (`room-bookings-client.ts:145`). The new entities need no payment-intent
  or confirm routes of their own.
- **Who may record.** Staff or a full API key (`routes/payments.js:6`,
  `routes/bookings.js:31-33`). Mirror that.
- **`payment` has no unique constraint on the intent id** (`schema.sql:443`);
  `roomPayments.js:479` dedupes in application code.
- **No report reads `payment`.** Its only readers are `bookings.js`,
  `folio.js`, `payments.js`, `roomPayments.js` and
  `lib/channels/reservations.js`, all by `booking_id`.
- **Golf base charge** is `price_per_player x players` (`golf.js:340`) and
  excludes hires linked through `equipment_hire.golf_booking_id`, so a round
  and its hire do not double-count.
- **`equipment_hire.total_price` is nullable**; treat null as 0.
- **Spa frozen price** is `spa_appointment.price`, read as
  `COALESCE(sa.price, st.price, 0)` (`folio.js:70`).
- **Stay linking** is set only by the import's `attachStays`
  (`spa.js:1798`). Cart-made appointments are never attached.
- **Restaurant setting in the staff app** goes next to the existing
  payment-protection select (`restaurant-dashboard-client.ts:341-407`).

Decided while sorting the reviewer's questions:

- **Telling website payments apart.** `POST /api/payments` takes no intent
  id today. It gains one, and a website-taken payment is recorded with a
  method that every Stripe-calling path skips (room cancel refunds in
  `bookings.js:568,766` and `roomPayments.js:350` key off the intent id).
  Read the room cancel path in full before choosing the marker. (call)
- **Restaurant deposits taken the existing way** live only as
  `restaurant_reservation.stripe_payment_intent_id`, their state known only
  to Stripe. The block totals `payment` rows only and adds an untotalled
  line saying a card deposit or hold exists on Stripe. No backfill, no
  Stripe call on read. (call)
- **`hold`.** The amount-due-now answer carries the mode, the amount and
  `due_now`; `due_now` is 0 for a `hold` restaurant. (call)
- **Per guest / per table default.** Existing restaurants default to per
  table (a flat amount), the column's plain meaning today. (call)
- **Cancelled bookings** drop their base charge, so the block shows what
  was taken as a credit, matching the restaurant-deposit rule. (call)

Answered by Robert (2026-11-12):

1. **Spa deposits are built now.** The existing spa payment flows in
   `spaPayments.js` (card terminal, cash, invoice and guest bill) stop
   assuming all-or-nothing at the frozen price. They charge the
   appointment's balance: price plus added charges minus what is already
   paid. `payment` rows become the record of what a spa appointment has
   paid. `payment_status` stays for existing readers and becomes `paid`
   when the balance reaches zero. An appointment already marked paid with
   no `payment` row shows a Paid line for its price at read time; there is
   no backfill. (Approach is a call; the decision to do it is Robert's.)
2. **Deposit rules are enforced.** OTA refuses a booking that does not
   carry the payment its venue requires. See "Enforcement" below.

## Enforcement

Robert chose enforcement. The rules below are calls.

- **Every rule defaults to no payment required.** Enforcement changes
  nothing for any property until a venue's rule is switched on. This is
  what keeps every other site's widget working on the day this ships.
- **Golf and equipment hire get a rule too**: no payment or full payment,
  per course and per equipment item, default no payment. (This replaces
  "full price at booking" above: full price is what Hamilton will set, not
  a fixed behaviour.)
- **What "carries the payment" means.** A guest-facing booking request
  states the amount paid and the intent it was paid on. OTA rejects it when
  the amount is less than what is due now for that venue, date and party.
  Where the intent is on the property's own Stripe account OTA checks it
  with Stripe; where a website charged on its own account (Hamilton), OTA
  trusts the amount stated by that website's API key, as it already trusts
  `payment_verified` on spa bookings.
- **A booking created this way gets its payment recorded in the same
  step**, so a paid booking and its Paid line cannot come apart.
- **Exempt:** staff in the staff app and full API keys (MCP, scripts), who
  can book unpaid and take payment at the desk; imports; edits to an
  existing booking. A `hold` restaurant is not enforced by this rule (its
  hold is handled as today).
- **Refused bookings** get one clear error naming the amount due, so a
  widget can show it.
- **Found while planning (2026-11-12): the Hamilton site holds a full API
  key.** It already calls `POST /api/payments`, which only staff and full
  keys may use. "Full API keys are exempt" would therefore exempt the very
  site this is for. The enforcement plan (plan 3) must decide exemption by
  what the request is, a guest booking from a website versus a staff or
  script action, not by key type alone. Unresolved; raise with Robert when
  plan 3 is written.
- **Switching a rule on is an operational step.** It must wait until every
  page that books that venue can take the payment. For Hamilton that means
  the site's cart and its separate golf, spa and restaurant pages.

## Non-goals

- A guest-facing bill for add-ons, or paying an add-on's balance online later.
- Moving an add-on's charges onto a room's folio on request ("charge to
  room") beyond what the spa import already does.
- Refunds through Stripe for website-taken payments.
- Tax handling beyond what each entity's price already includes.
- Reporting changes (profit and loss, QuickBooks). If those read `payment`
  by `booking_id`, they must not break, but including the new payments in
  them is a follow-up. (call)

## Anti-goals

- The same amount owed in two places.
- An existing room folio, spa bill or check-out gate changing its numbers.
- A payment that belongs to no booking.

## Left to the builder

- How `payment` and `folio_adjustment` reference the other entities
  (a nullable reference per entity with an exactly-one check keeps foreign
  keys; a type-and-id pair is less schema). Pick one and migrate without
  touching existing rows' meaning.
- Route shapes, mirroring the bookings folio routes so the staff block is
  one shared piece of code.
- How spa's `payment_status` is kept true once deposits exist.
- Migration file layout and the order of the four entities.

## Suggested order

1. Golf bookings: charges, payments, staff block. Smallest, proves the pattern.
2. Equipment hires.
3. Restaurant reservations, with the per-guest / per-table setting.
4. Spa appointments, with the spa deposit setting, reconciled with the
   existing spa bill.
5. The amount-due-now answer for each kind, then enforcement on each
   guest-facing create path, with every rule still defaulting to off.
