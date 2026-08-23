# Restaurant table sessions — OTA backend requirements

Date: 2026-08-23

## Context

The waitress app (`ota-waitress-app`) currently has each table tap create a brand-new, independent `restaurant_order` row. There is no way to "add to" an existing order, and no concept groups multiple rounds (drinks, then mains, then dessert) or their combined total for a single table sitting. This blocks two things directly: (1) a waitress adding more items without creating an unrelated duplicate order, and (2) billing — there is currently no way to know "everything this table owes right now" once individual orders start reaching `delivered` status (which already excludes them from any "active" grouping).

This spec is decided, not a stub — it's meant to be implemented as written, not re-designed. It covers the table-session entity and the endpoints needed to open/attach-to/close one. It deliberately does **not** cover Stripe Tap to Pay integration — that's the existing, separately-tracked gap (`2026-08-16-mobile-ordering-app-backend-requirements.md`, section 2) and depends on frontend Stripe Terminal SDK work outside this scope. The close endpoint below is what that work will eventually call; nothing here blocks on it.

## 1. New table: `restaurant_table_session`

```sql
CREATE TABLE IF NOT EXISTS restaurant_table_session (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id   UUID         NOT NULL REFERENCES property(id),
  restaurant_id UUID         NOT NULL REFERENCES restaurant(id),
  table_id      UUID         NOT NULL REFERENCES restaurant_table(id),
  status        VARCHAR(20)  NOT NULL DEFAULT 'open',
  opened_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ,
  CONSTRAINT restaurant_table_session_status CHECK (status IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_restaurant_table_session_table
  ON restaurant_table_session(table_id);

-- Enforces "at most one open session per table" at the DB level -- this is
-- the invariant the whole design leans on, so it isn't just app-logic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurant_table_session_one_open
  ON restaurant_table_session(table_id) WHERE status = 'open';
```

## 2. `restaurant_order` gets `table_session_id`

Nullable: room-service orders (`booking_id` set, `table_id` null) never get one. Table-based orders always will, going forward.

```sql
ALTER TABLE restaurant_order
  ADD COLUMN IF NOT EXISTS table_session_id UUID REFERENCES restaurant_table_session(id);

CREATE INDEX IF NOT EXISTS idx_restaurant_order_table_session
  ON restaurant_order(table_session_id);
```

**Backfill required** — unlike the `restaurant_id` migration on 2026-08-15, this repo now has live table-based orders from the waitress app's own testing (confirm row count before running; do not assume zero rows this time). For every existing `restaurant_order` row with `table_id IS NOT NULL AND table_session_id IS NULL`, group by `table_id` and create one **closed** `restaurant_table_session` per distinct table (`opened_at` = earliest `created_at` among that table's orders, `closed_at` = now), then set `table_session_id` on those orders to match. Closing them immediately on backfill is deliberate: it avoids ever violating the one-open-session-per-table unique index with historical data, and none of that pre-existing test data represents a real still-open tab.

```sql
DO $$
DECLARE
  t RECORD;
  new_session_id UUID;
BEGIN
  FOR t IN
    SELECT DISTINCT table_id, restaurant_id, property_id
    FROM restaurant_order
    WHERE table_id IS NOT NULL AND table_session_id IS NULL
  LOOP
    INSERT INTO restaurant_table_session (property_id, restaurant_id, table_id, status, opened_at, closed_at)
    SELECT t.property_id, t.restaurant_id, t.table_id, 'closed',
           MIN(created_at), now()
    FROM restaurant_order
    WHERE table_id = t.table_id AND table_session_id IS NULL
    RETURNING id INTO new_session_id;

    UPDATE restaurant_order
    SET table_session_id = new_session_id
    WHERE table_id = t.table_id AND table_session_id IS NULL;
  END LOOP;
END $$;
```

Run this and the two schema changes above as one migration file, `migrate-2026-08-23-restaurant-table-sessions.sql`, following this repo's existing one-off/idempotent convention (`IF NOT EXISTS` throughout; the backfill loop is naturally idempotent since it only ever targets rows where `table_session_id IS NULL`).

## 3. `createOrder` — attach to the table's open session

In `src/controllers/restaurantOrders.js`, when `table_id` is provided (the existing branch that validates the table), also:

1. Look up an existing row in `restaurant_table_session` for that `table_id` with `status = 'open'`.
2. If none exists, insert one (`property_id`, `restaurant_id`, `table_id` from the request — same values already validated for the order itself).
3. Set the new order's `table_session_id` to that session's id.

This is the entire mechanism for "add to order" — no new item-append endpoint is needed. A waitress adding more items just calls the existing `createOrder` again for the same table; it automatically lands in the same open session as a new round/order row, with its own kitchen ticket. Repeated identical items across rounds don't need merge logic — they're naturally separate rows in separate orders, which is also correct for the kitchen (each round is printed/tracked independently).

Room-service orders (`booking_id` set) are unaffected — skip all of the above when `table_id` is absent.

## 4. New endpoint: list a table's open session with its orders

```
GET /api/restaurant-table-sessions?table_id=<uuid>&status=open
```

- `authenticateOrApiKey`, scoped to `req.property_id` (same pattern as every other list endpoint in this module).
- Returns the session row plus its orders (reuse the same joined-order query shape `listOrders` already builds — `o.*`, `items` via `json_agg`, and the `room_number` join isn't relevant here since these are always table-based).
- The waitress app uses this to know, before showing "Add to order" vs "New order" on a table, whether an open session already exists and what's already been ordered under it.

## 5. New endpoint: close a session

```
PUT /api/restaurant-table-sessions/:id/close
```

- `authenticateOrApiKey`.
- Reject with `409` if any order under the session has `status` in `('pending', 'confirmed', 'preparing')` — a session can't close while food is still coming. Error body: `{ error: 'Cannot close: N order(s) still active' }`.
- On success: `status = 'closed'`, `closed_at = now()`. Returns the updated session.
- This is deliberately payment-agnostic — it's "mark this table's tab done," callable from a manual "Close table" action today, and from the Stripe Tap to Pay flow later once that's built (charge succeeds → call this same endpoint). Don't gate this endpoint on any payment field existing; that's the separate, still-undecided spec section referenced above.

## Verification

Following this repo's established `curl`-based convention (no test framework for controllers) — write end-to-end curl scripts, hitting a real running instance, covering: session auto-created on first table order; second order for the same table reuses the same `table_session_id`; the unique-open-session index actually rejects a second concurrent open row (`INSERT` directly, expect a constraint violation); close endpoint's 409 when an active order exists; close succeeds once all orders are delivered/cancelled; backfill migration on a copy of live data produces exactly one closed session per pre-existing table_id with orders.

## What this spec deliberately doesn't cover

Stripe Tap to Pay charge collection and payment-status tracking on either `restaurant_order` or the new session table — still the open question in the 2026-08-16 stub, unchanged by this doc. Any UI for a manual "Close table" action — that's the waitress app's concern, not this spec's.
