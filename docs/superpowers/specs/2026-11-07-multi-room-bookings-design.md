# Multi-room room bookings — design

2026-11-07. API only. The website front end and the dashboard UI are built on top of it later.

## Why

Hotel websites use a standard search form: dates, then "Room 1: adults / children", "+ Add room",
"Check rates". Today OTA can sell only one room per booking. A guest booking two rooms has to check
out twice and pay twice. Nothing stops two of their rooms from both being put in the last Deluxe.
If the second room fails, the first is already held. Robert wants the website to take a
multi-room stay as one checkout.

## How the guest sees it

1. The guest enters dates and the rooms (adults and children for each), then presses "Check rates".
2. **Nothing is picked by the guest up front.** OTA returns a basket with every room already on the
   **cheapest room type that fits its guests**, at the **cheapest rate**.
3. The guest can **change** a room's type, or **change the rate**. The rate always applies to the
   **whole basket** (Robert). The total updates.
4. One card payment covers every room. They get one confirmation email listing all the rooms.
5. From the website, a guest can **only cancel the whole booking** (Robert), on the rate's terms.

## Goals

1. **Quote.** Given dates and a list of rooms with occupancy, return a priced basket.
   - Default: each room on the cheapest fitting type at the cheapest basket rate.
   - Alternatives per room (other fitting types) and per basket (other rates), each priced.
   - Inventory is counted across the basket, so the basket never needs more rooms of a type than
     can be sold: physical rooms plus the oversell allowance, the same rule as `holdStay`.
2. **Create.** Book every room in the basket in **one transaction, all or nothing**. If any room can't
   be held, nothing is booked and the response is a 409 that says which room failed.
3. **One payment.** One Stripe PaymentIntent for the whole basket, with one pay window. Expiry,
   confirmation and hold capture all act on the basket as a whole.
4. **One basket in the abandoned-basket feed and reminder**, listing each room, not one per room.
5. **One email** per event (pay request, confirmation, basket reminder) listing every room.
6. **Guest cancel = whole basket**, under the rate's terms (refund, refuse, release).
7. **Each room stays its own `booking` row**, so staff tools keep working per room: move, walk,
   check-in, folio, housekeeping, staff cancel of one room.
8. Staff can use the same multi-room create (including `pay_at_hotel`).
9. **Single-room bookings behave exactly as today.** Same request, same response, same emails.

## Non-goals

- Different rates for different rooms in one basket.
- A guest cancelling one room of a basket from the website.
- Channel (OpenTravel) multi-room reservations. These are still rejected
  (`src/lib/channels/opentravel/messages.js:113`). That is a separate piece of work.
- Holding inventory at quote time. A quote is a price, not a hold.
- Child ages or child pricing. Children count towards occupancy only.
- Website and dashboard UI.

## Anti-goals (a failure even if it works)

- A partly booked basket: some rooms held or charged while others failed.
- Charging the guest more than once for one basket, or charging for a room that wasn't booked.
- The default basket putting two rooms in the last room of a type, or overselling past
  `holdStay`'s rules.
- Any change to how single-room bookings, their payments, emails or baskets behave.
- A basket that the expiry job half-expires (some rooms expired, others still pending).

## Decided

- **Rate = rate plan name across types.** Rate plans belong to a room type (`rate_plan.room_type_id`).
  A basket rate means "the plan with this name on each room's type" ("Saver", "Flex"). If a room type
  has no active plan with that name, it is not offered under that rate. The default rate is the
  one that gives the cheapest basket total. Every room in a basket has the same plan name, so the
  basket has one payment mode (`full` / `deposit` / `hold`) and needs only one PaymentIntent.
  *(Claude's call, from Robert's "rate applies to the whole basket")*
- **Grouping:** each room is a `booking` row carrying a shared basket/group id. A single-room booking
  has no group, so it is unchanged.
- **Occupancy:** a room's `guests` = adults + children, and it must be ≤ the type's `max_occupancy`.
  Children are not stored separately (OTA keeps minimal data). *(Claude's call)*
- **The quote is stateless.** The website keeps the basket and calls quote again with the guest's
  changes. Create re-checks everything and re-prices server-side. It never trusts prices sent by
  the client. *(Claude's call)*
- **Website payment uses the existing routes.** `POST /api/bookings/:id/payment-intent` and
  `/confirm-payment` with any booking id in the basket act on the whole basket, so the website
  needs no new payment routes. The same goes for `DELETE /api/bookings/:id` via API key (cancels
  the whole basket). Staff `DELETE` on a grouped booking cancels **only that room**, with no
  automatic refund, as staff cancel works today. *(Claude's call)*
- **Folios stay per room.** The basket's single Stripe payment is recorded as one `payment` row
  per booking, each with that room's share, so every room's folio balances. *(Claude's call)*
- **Quote access:** same as availability search (public with `property_id`, or API key / staff).
  *(Claude's call)*
- **Room types with no rate plan** sit under one unnamed rate ("no online payment"). They book as
  `confirmed` with no card, as single-room bookings do today, and they never appear under a named
  rate. A basket rate is offered only if every room in the basket can be placed under it.
- **Same name = same terms (Robert: "a booking should have one rate").** Creating or updating a
  rate plan is refused with a 409 if another active plan with the same name at the property has
  different terms: `payment_mode`, `refundable`, `cancel_cutoff_hours`, `deposit_kind` or
  `deposit_value`. `adjustment_pct` may differ per type. On live, all 6 properties already
  comply (checked 2026-11-07), so no data needs fixing.
  *(Claude's call)*
- **When a room doesn't fit,** the quote still returns 200:
  - rates that can't place every room are left out;
  - if no rate can place every room, the basket comes back `available: false`, with the room(s)
    that failed and why (too many guests for any type, or sold out).

  *(Claude's call)*
- **"Cheapest" means the lowest basket total**, not each room on its cheapest type in turn. Baskets
  are small (a handful of rooms), so trying the combinations under the stock limits is fine.
  *(Claude's call)*
- **Staff cancelling one room of a basket:**
  - **Not paid yet (`pending_payment`):** refused with a 409. Cancel the whole basket or wait for
    payment, because one shared PaymentIntent can't be cut down part-way through checkout.
  - **Card hold:** the room is released and the later capture takes less. Stripe allows capturing
    less than was authorised.
  - **Paid:** no automatic refund, as staff cancel works today.

  *(Claude's call)*
- **A guest cancelling the whole basket** refunds or releases the basket's single PaymentIntent
  once, not once per room. *(Claude's call)*

## Left to the builder

- Endpoint shape: a new `POST /api/bookings/quote` (or similar), and `rooms: [...]` on
  `POST /api/bookings` versus a separate create route. Keep the single-room request/response
  untouched.
- How the alternatives are shaped in the quote response (absolute prices or deltas). The website
  must be able to show "Room 2: Deluxe +€40" without doing its own maths.
- Whether the group is a nullable `booking.group_id` column only, or a small `booking_group` table
  if basket-level fields (PaymentIntent, pay window) sit better there.
- How `paymentIntentFor`, `confirmPaid`, `expireOnce`, `captureHoldsOnce`, `stripeForCancel`,
  `listOpenRoomBaskets` / reminders and `roomBookingEmails` learn about groups. Lock every booking
  in the group in a stable order to avoid deadlocks.
- Basket "closed by a later booking" rule (`roomBaskets.js` `OPEN`): bookings in the same group
  must not close each other.
- Deposit on a basket: work it out on the basket total (percent), or once per basket (fixed). It
  should read the way the plan reads to a guest booking a single room.
- Staff pay-request email for a staff-created multi-room basket.

## Done means (CLAUDE.md checklist)

- Dated migration `src/db/migrate-2026-11-07-multi-room-bookings.sql` + `schema.sql`.
- Swagger for the quote route and the `rooms` create shape, plus the group behaviour on the
  payment and cancel routes.
- **MCP tools:** a quote tool, and `create_booking` taking `rooms`.
  `node -r dotenv/config scripts/check-mcp-coverage.js` passes.
- `scripts/check-multi-room-bookings.js` (local DB only, refuses a remote DB). It covers:
  - the default basket picks the cheapest types and rate;
  - the last room of a type is not used twice;
  - create is all-or-nothing;
  - one PaymentIntent for the basket total;
  - confirm, expire and guest cancel act on the whole basket;
  - staff cancel touches one room only;
  - the feed shows one basket;
  - single-room bookings are unchanged.
- Live migration with Robert's OK **before** pushing.
