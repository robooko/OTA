# Mobile ordering app — OTA backend requirements (stub)

Date: 2026-08-16

## Context

A new mobile app (React Native/Expo) is being built as a separate project — a combined waitress+kitchen tool: staff pick a restaurant at login, take orders against `restaurant_order`/`restaurant_menu_item` (already live in this repo), watch order status live, and collect payment table-side via Stripe Terminal Tap to Pay.

This is **not a finished design** — it's a stub written from the client side's perspective, captured so a dedicated OTA-scoped session can turn it into a real spec+plan (following this repo's existing `docs/superpowers/specs/` + `plans/` convention) before implementing. Two independent additions are needed; treat them as separate specs if that's easier to sequence.

## 1. Real-time order events via Ably — build now

The mobile app needs to see order status change (`pending → confirmed → preparing → delivered/cancelled`) without polling. `src/lib/ably.js` and the `event_inquiry` module already established the pattern this repo uses for realtime — reuse it, don't invent a new one.

- **Publish two new events** from `src/controllers/restaurantOrders.js`, same best-effort/awaited/non-fatal shape `publishNewInquiry` uses (a publish failure must never fail the underlying request):
  - `createOrder` → publish `new-order` with the full created order (incl. `items`).
  - `updateOrderStatus` → publish `order-status-changed` with at least `{ id, status, restaurant_id }` — keep it minimal, the client already has the rest of the order locally.
- **Channel naming — deliberately differs from `event_inquiry`'s per-*property* scoping.** A property can have multiple restaurants (`restaurant_id` scoping already exists throughout this module), and a given waitress/kitchen screen only cares about the one restaurant picked at login — scoping broader than that means filtering noise client-side for no reason. Recommend per-*restaurant* channels: `restaurant:{restaurant_id}:orders`.
- **New: OTA needs its own Ably token-minting endpoint.** `event_inquiry`'s spec deliberately put token-minting in the web frontend's own server, not OTA, reasoning that the raw `ABLY_API_KEY` should never reach a browser from either repo. That reasoning assumed a frontend *with its own server* to mint from. A native mobile app has no equivalent server layer of its own — OTA is the only reasonable place left. This is a deliberate, scoped divergence from that precedent, not an oversight.
  - Suggested: `POST /api/restaurant/orders/ably-token` (adjust to fit this module's actual route conventions), `authenticate`-only (Clerk).
  - Body: `{ restaurant_id }`. Validate it belongs to `req.property_id`, same check `createOrder`/`createMenuItem` already do.
  - Mint via `client.auth.createTokenRequest({ capability: { ['restaurant:' + restaurant_id + ':orders']: ['subscribe'] } })` — **subscribe-only**, scoped to exactly one restaurant's channel, nothing broader. Return the token request object; the mobile app hands it to Ably's client SDK.

## 2. Payment tracking on `restaurant_order` — spec only, do not implement yet

**Confirmed gap, not a design choice**: `restaurant_order` has no field or relationship recording that a payment (e.g. Tap to Pay) was ever collected against it. The existing `payment` table only links to `booking_id` (`NOT NULL`) — a table-only restaurant order (`table_id` set, `booking_id` null, which `createOrder` explicitly allows) has nowhere to record a charge at all today.

Two shapes, undecided — whoever designs this for real should pick one:

- **Option A (lean towards this)**: add payment fields directly on `restaurant_order` — `payment_status VARCHAR(20) DEFAULT 'unpaid'` (`unpaid`/`paid`/`refunded`), `paid_at TIMESTAMPTZ`, `stripe_payment_intent_id VARCHAR(255)` (for reconciling against Stripe's own Terminal records). Reasoning: the existing `payment` table was built for hotel-booking installments/refunds across multiple payments per booking; a Tap to Pay restaurant charge is a single atomic in-person transaction, no split/partial/refund flow discussed yet — reusing that table's shape would be forcing a fit that isn't there.
- **Option B**: keep one unified payments ledger — relax `payment.booking_id` to nullable, add `payment.restaurant_order_id UUID REFERENCES restaurant_order(id)`, and a `CHECK` requiring exactly one of the two set. Mirrors `restaurant_order`'s own existing `CHECK (booking_id IS NOT NULL OR table_id IS NOT NULL)` pattern.

Either way, a new endpoint is needed for the mobile app to report a successful charge back once Stripe confirms it client-side — e.g. `PUT /api/restaurant/orders/:id/payment`, or folded into the existing `PUT /api/restaurant/orders/:id/status`. Left open: exact endpoint shape, and whether a failed/cancelled Tap to Pay attempt needs any server-side record at all (probably not — only successful charges matter).

## What this stub deliberately doesn't cover

Exact migration SQL, exact controller/route code, exact `curl`-based verification steps (this repo's established testing convention) — that's real design work for a proper spec pass in an OTA-scoped session, not something to fake here. This stub exists to hand off requirements, not to pre-decide implementation details from outside the repo.
