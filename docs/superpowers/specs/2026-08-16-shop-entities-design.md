# Pro Shop module: multiple shops per property

## Context

`proshop_item` was just scoped to `property_id`
(`docs/superpowers/specs/2026-08-16-proshop-property-scoping-design.md`),
giving every property one flat catalogue. The companion frontend spec
(`docs/superpowers/specs/2026-08-16-shop-page-design.md` in
`ota-table-bookings`) built that as a single grid page.

A property can actually run several distinct shops (e.g. Dive, Gift,
Pro Shop), each with its own catalogue and its own item categories.
This phase adds a `shop` entity — the same parent-entity shape as
`restaurant` (parent of `restaurant_menu_item`) and `golf_course`
(parent of `tee_time`) — and scopes `proshop_item` underneath it.

There is already real data locally: 4 `proshop_item` rows (3 golf-gear
items on one property, 1 test item on another), none of which can be
auto-assigned to a shop with confidence. Per the user's decision, these
are left with `shop_id = NULL` and reassigned by hand after this phase
ships — no migration-time backfill, no UI path for reassignment.

## Goals

- New `shop` table: `id`, `property_id`, `name`, `description`,
  `status` — mirrors `restaurant`/`golf_course`'s minimal shape (no
  booking-related fields; shop has no reservation flow).
- `proshop_item` gains a nullable `shop_id UUID REFERENCES shop(id)`.
- Catalogue routes (`GET`/`POST /api/proshop/items`) scoped by
  `shop_id` in addition to `property_id`.
- New CRUD routes for the `shop` entity itself, under
  `/api/proshop/shops`, same file as the existing catalogue routes.

## Non-goals

- No backfill or auto-created default shop for the 4 existing rows —
  confirmed with the user, they stay `shop_id = NULL` and get fixed by
  hand.
- No UI or API convenience for finding/reassigning NULL-`shop_id`
  items — confirmed with the user, a one-off manual fix is enough.
- No cascade behavior when a shop is soft-deleted (`status:
  'inactive'`) — its items are left exactly as they are, just
  unreachable via the UI (same "orphan, don't touch" handling as the
  NULL-`shop_id` rows). No destructive cascade, no automatic item
  status change.
- No change to `golf_booking_item` or its routes — item-to-booking
  attachment is still out of scope (per the original shop-page spec);
  which shop an attachable item belongs to is a question for whoever
  picks that follow-up up, not decided here.
- No change to auth model — everything stays `authenticate` (Clerk),
  matching proshop.js's existing convention; nothing here is
  guest-initiated.

## Data model

```sql
CREATE TABLE IF NOT EXISTS shop (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_shop_property ON shop(property_id);

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shop(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_shop ON proshop_item(shop_id);
```

`shop_id` is nullable at the DB level — a `NOT NULL` add would fail
outright against the 4 existing rows without a `DEFAULT`, and the user
explicitly ruled out auto-assigning a default shop. Nullability is
enforced away at the API layer instead: `createItem` requires
`shop_id` in the body going forward (`400` without it), so only the
pre-existing legacy rows can ever be NULL in practice.

`schema.sql` updated in place: the new `shop` table added alongside
`restaurant`/`golf_course`, and `proshop_item` declares `shop_id` in
its `CREATE TABLE` from the start (a fresh reset never needs the
migration).

## API & behavior

```
GET    /api/proshop/shops           authenticate, scoped to req.property_id, status = 'active'
POST   /api/proshop/shops           authenticate, body: { name, description? } → 201
PUT    /api/proshop/shops/:id       authenticate, body: any of { name, description, status } → scoped

GET    /api/proshop/items?shop_id=X authenticate, scoped to req.property_id AND shop_id (shop_id required)
POST   /api/proshop/items           authenticate, body now requires shop_id → 400 if missing
PUT    /api/proshop/items/:id       unchanged (name/description/category/price/status)
```

Controller changes (`src/controllers/proshop.js`):

- New `listShops`/`createShop`/`updateShop`, same shape as
  `listItems`/`createItem`/`updateItem` — `WHERE status = 'active' AND
  property_id = $n`, `COALESCE` on update, soft-delete via `status`.
- `listItems`: add `AND shop_id = $n` when `?shop_id=` is present.
  `shop_id` is required by the frontend (every call is made from
  inside a shop's items dialog) but not enforced as required at the
  route level for `GET` — an omitted `shop_id` simply returns nothing
  scoped, consistent with how `category` is already an optional filter
  here. Only `createItem` hard-requires it.
- `createItem`: validate `shop_id` is present (`400` if not, alongside
  the existing `name`/`price` check) and belongs to `req.property_id`
  (`404` if the shop doesn't exist or belongs to another property —
  same foreign-id-returns-404 rule as everywhere else in this
  codebase). Insert includes `shop_id`.
- `updateItem`: no change beyond what already exists — `shop_id` is
  not editable via this endpoint (moving an item between shops isn't a
  requirement here; YAGNI).

`src/docs/swagger.js` gets the new `/shops` paths documented and
`POST /items`'s body schema updated to include required `shop_id`.

## Migration & rollout

One migration file, run against local then live:

```sql
CREATE TABLE IF NOT EXISTS shop (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID         NOT NULL REFERENCES property(id),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  status      VARCHAR(20)  DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_shop_property ON shop(property_id);

ALTER TABLE proshop_item ADD COLUMN IF NOT EXISTS shop_id UUID REFERENCES shop(id);
CREATE INDEX IF NOT EXISTS idx_proshop_item_shop ON proshop_item(shop_id);
```

Idempotent-safe via `IF NOT EXISTS`. No backfill statement — the 4
existing rows keep `shop_id = NULL` until fixed by hand (direct SQL or
psql-less `pg` script, matching how this environment already runs
one-off DB work).

## Testing approach

No automated test framework — manual checks (`curl`/local dev):

1. Run the migration locally. Confirm `shop` exists and the 4 existing
   `proshop_item` rows now have `shop_id = NULL`.
2. `POST /api/proshop/shops` with a staff token → `201`, `property_id`
   matches the caller. Create three: Dive, Gift, Pro Shop.
3. `GET /api/proshop/shops` → only that property's active shops,
   ordered sensibly.
4. `PUT /api/proshop/shops/:id` with `{ status: 'inactive' }` → shop
   disappears from the `GET` list. Confirm its items (if any) are
   untouched in the DB (`shop_id` still set, `status` still whatever
   it was) — no cascade.
5. `POST /api/proshop/items` without `shop_id` → `400`. With a
   `shop_id` belonging to a different property → `404`. With a valid
   `shop_id` → `201`, item scoped correctly.
6. `GET /api/proshop/items?shop_id=X` → only items for that shop, not
   other shops on the same property.
7. Confirm the 4 legacy rows never appear in any `?shop_id=` filtered
   list (they have no shop_id to match).
8. Repeat the core checks (2, 5, 6) against live once local passes.
