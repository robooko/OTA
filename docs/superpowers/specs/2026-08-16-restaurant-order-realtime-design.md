# Restaurant order realtime events (mobile ordering app support)

## Context

A separate mobile app (React Native/Expo, waitress+kitchen tool) is
being built against this repo's existing `restaurant_order`/
`restaurant_menu_item` API. A requirements stub for it
(`docs/superpowers/specs/2026-08-16-mobile-ordering-app-backend-requirements.md`)
asked for two independent additions; this spec covers the first
(realtime order events), confirmed with the user to build now. The
second (payment tracking on `restaurant_order`) is a separate,
spec-only pass — see
`docs/superpowers/specs/2026-08-16-restaurant-order-payment-tracking-design.md`
(not implemented).

Sanity-checked the stub against the actual code before writing this:
`createOrder`/`updateOrderStatus` exist exactly as named in
`src/controllers/restaurantOrders.js`, `restaurant_id` scoping is
already threaded throughout that module, and the existing route file
already splits auth per-action the same way this spec assumes
(`createOrder` is `authenticateOrApiKey`, guest/widget-reachable;
`updateOrderStatus` is `authenticate`-only, staff/kitchen-only) — so a
new staff-only token-minting endpoint matches established precedent,
not a new pattern.

The stub's suggested route path (`/api/restaurant/orders/ably-token`)
doesn't match this module's actual registered prefix
(`/api/restaurant-orders`, confirmed in `app.js`) — corrected below.
Its suggested `POST` with `restaurant_id` in the body is also changed
to `GET` with a query param, matching every other read-only
lookup/search endpoint in this codebase (`/equipment/search`,
`/golf/tee-times/search`) rather than introducing a POST-for-a-read
exception.

## Goals

- `createOrder` publishes a `new-order` Ably event (full order incl.
  `items`) on every successful order creation.
- `updateOrderStatus` publishes an `order-status-changed` event
  (`{ id, status, restaurant_id }`) on every successful status change.
- Both publish to a per-*restaurant* channel (`restaurant:{restaurant_id}:orders`)
  — deliberately narrower than `event_inquiry`'s per-*property*
  channel, since a property can have multiple restaurants and a given
  kitchen/waitress screen only cares about the one picked at login;
  scoping broader would mean filtering noise client-side for nothing.
- `GET /api/restaurant-orders/ably-token?restaurant_id=X` — the mobile
  app's own token-minting endpoint. Unlike `event_inquiry`'s
  equivalent (which lives in the web frontend's Astro server, since
  that frontend has its own server layer to mint from), a native
  mobile app has no such layer — OTA is the only reasonable place
  left for this one. This is a deliberate, scoped divergence from the
  `event_inquiry` precedent, not an inconsistency.

## Non-goals

- No payment tracking — separate spec-only pass, not implemented here.
- No change to `createOrder`/`updateOrderStatus`'s existing validation,
  response shape, or auth requirements — the publish call is additive,
  inserted after the existing success path, same as `event_inquiry`'s
  `createInquiry`.
- No retry/queue if a publish fails — logged and dropped, matching
  `publishNewInquiry`'s existing best-effort framing. The order/status
  change itself is always safely in Postgres regardless.
- No guest-facing token-minting — `GET .../ably-token` is
  `authenticate`-only; a guest has no reason to open a realtime
  connection to kitchen/waitress order events.
- No change to `event_inquiry`'s own Ably wiring or channel — this
  spec only adds new functions to `src/lib/ably.js` alongside the
  existing `publishNewInquiry`, doesn't touch it.

## API & behavior

```
GET /api/restaurant-orders/ably-token?restaurant_id=X   authenticate, validates restaurant belongs to req.property_id
```

`src/lib/ably.js` gains two new exports alongside the existing
`publishNewInquiry`, reusing the same module-level `client`:

```js
async function publishNewOrder(restaurantId, order) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('new-order', order);
}

async function publishOrderStatusChanged(restaurantId, payload) {
  if (!client) return;
  const channel = client.channels.get(`restaurant:${restaurantId}:orders`);
  await channel.publish('order-status-changed', payload);
}
```

`src/controllers/restaurantOrders.js` changes:

- `createOrder`: after `await client.query('COMMIT')`, before
  `res.status(201).json(...)`, call
  `publishNewOrder(restaurant_id, { ...order[0], items: resolvedItems }).catch((err) => console.error('Ably publish failed:', err.message));`
  — same fire-and-forget, logged-not-thrown shape as `createInquiry`.
- `updateOrderStatus`: after the `UPDATE ... RETURNING *` succeeds,
  call
  `publishOrderStatusChanged(rows[0].restaurant_id, { id: rows[0].id, status: rows[0].status, restaurant_id: rows[0].restaurant_id }).catch((err) => console.error('Ably publish failed:', err.message));`
  before `res.json(rows[0])`.

New controller function `getAblyToken` (added to
`src/controllers/restaurantOrders.js`, exported alongside the rest):

```js
async function getAblyToken(req, res, next) {
  try {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });

    const { rows } = await pool.query(
      'SELECT id FROM restaurant WHERE id = $1 AND property_id = $2',
      [restaurant_id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });

    const channel = `restaurant:${restaurant_id}:orders`;
    const tokenRequest = await ablyClient.auth.createTokenRequest({
      capability: { [channel]: ['subscribe'] },
    });
    res.json({ tokenRequest, channel });
  } catch (err) { next(err); }
}
```

This needs the raw Ably `Rest` client (for `.auth.createTokenRequest`),
not just the `publishNewOrder`/`publishOrderStatusChanged` wrapper
functions — `src/lib/ably.js` additionally exports the `client`
instance itself (adds `client` to `module.exports` alongside the two
publish functions, no rename inside `ably.js`) so
`restaurantOrders.js` can reach `.auth` directly, matching how the
`event_inquiries-client.ts` frontend endpoint used the raw Ably `Rest`
client for the exact same `createTokenRequest` call.
`restaurantOrders.js` imports it renamed to avoid ambiguity with any
other `client` in scope (there is a per-request `client` from
`pool.connect()` inside `createOrder`'s transaction):

```js
const { publishNewOrder, publishOrderStatusChanged, client: ablyClient } = require('../lib/ably');
```

`src/routes/restaurantOrders.js` gains:
```js
router.get('/ably-token', authenticate, ctrl.getAblyToken);
```
Placed before the `/:id` routes (Express route-matching order matters
— `/ably-token` would otherwise never be reached if a `/:id`-shaped
route were registered first and matched it as an `id` value).

`src/docs/swagger.js` gets a new path entry for
`/api/restaurant-orders/ably-token` under the existing `Restaurant
Orders` tag (matching the tag name already used by every other path in
this file, even though the tags array itself declares it as `Room
Service` — a pre-existing mismatch in this file, not something this
spec fixes, out of scope).

## Testing approach

No automated test framework — manual `curl` checks against a running
`npm start`, plus Ably channel history checks (same technique used to
verify `event_inquiry`'s publish):

1. `GET /api/restaurant-orders/ably-token` with no `restaurant_id` →
   `400`. With a foreign restaurant's id → `404`. With no auth → `401`.
2. With a valid `restaurant_id` and Robs's Clerk token → `200`,
   `channel` matches `restaurant:{id}:orders`, `tokenRequest` is a
   real signed Ably token request (has `keyName`/`mac`).
3. Create an order via `POST /api/restaurant-orders` (needs an active
   restaurant, a table or booking, and a menu item — reuse whatever
   exists from prior sessions' restaurant/table/menu-item setup, or
   create fresh fixtures). Confirm `201` as before (no regression),
   then check Ably channel history for
   `restaurant:{restaurant_id}:orders` — confirm a `new-order` event
   arrived with the same order id and items.
4. `PUT /api/restaurant-orders/:id/status` with a valid status.
   Confirm `200` as before, then check the same channel's history for
   an `order-status-changed` event with the matching `id`/`status`.
5. Temporarily break `ABLY_API_KEY` (already proven safe by
   `event_inquiry`'s own Task 12-equivalent check, but re-confirm
   here since this is a different code path): both `createOrder` and
   `updateOrderStatus` still succeed and return normally; only a
   logged `Ably publish failed: ...` line appears server-side.
6. Confirm an inquiry's `new-inquiry` event and an order's `new-order`
   event never cross-appear on each other's channels — trivially true
   since the channel names differ entirely (`property:...:inquiries`
   vs `restaurant:...:orders`), but worth a quick sanity look at each
   channel's history independently to confirm no accidental shared
   channel naming collision.
