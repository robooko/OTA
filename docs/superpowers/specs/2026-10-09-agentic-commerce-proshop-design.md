# Sell pro shop items through AI agents (Stripe Agentic Commerce)

## Context

Stripe's Agentic Commerce Suite (ACS) lets a seller list products in AI
agents (ChatGPT and others) and take payment there:
<https://docs.stripe.com/agentic-commerce/sellers/use-cases/retail>.
The seller uploads a CSV catalog feed; the agent and Stripe run checkout
and payment; the seller fulfils from completed Checkout Sessions. Nothing
on the seller's website has to change beyond each product having a
landing page that resolves.

Decided with the user:

- **Pilot venue: WillyT** (site repo `willy-t-bvi`, Astro + Sanity,
  served at `https://willy-t-bvi.vercel.app`). The site does not change.
- **Its Stripe account is the one already stored** in
  `property.stripe_secret_key`: GB, sole trader, test mode today. GB is an
  ACS country, and a GB account can charge USD, so prices stay in
  WillyT's currency (USD).
- **Product links use `https://willy-t-bvi.vercel.app` permanently.**
  `willytbvi.com` still serves the old WordPress shop.
- **Per-property Stripe accounts, not Connect.** OTA is not a Connect
  platform; each venue's own key is used, so the plain retail seller
  guide applies per property. (The platform variant is US-only and
  waitlisted.)
- **Content is read from the site's public Sanity at feed time**, not
  stored in OTA (see the "OTA holds minimal data" rule; `proshop_item`
  lost its `description` column on 2026-09-29 for the same reason).
- **Agent orders are pulled by a polling sweep**, not a webhook, so no
  webhook endpoint or signing secret has to be registered per venue.

## Goals

- A per-property `agentic_commerce` setting holding the pointers the
  feed needs.
- A job that uploads WillyT's catalog to Stripe: pricing and inventory
  every 15 minutes, the full product feed daily.
- A job that turns completed agent Checkout Sessions into paid
  `proshop_order`s with the same side effects as a website order (stock,
  live staff feed, confirmation email).
- API + MCP tools to read and set the setting.

## Non-goals

- Collection/pickup through agents. The feed format has no pickup option;
  agent sales are US delivery only.
- Stripe's live price/availability checkout hook. Oversell between
  15-minute inventory pushes is accepted (WillyT tracks stock on 2 items).
- Automatic refunds. Returns already end with staff refunding in the
  Stripe dashboard; agent orders do the same.
- Promotions feed, reviews/Q&A enrichment fields, Stripe Tax codes.
- An OTA-side "delete everything from Stripe" on disable. The off switch
  is disabling the agent connection in the venue's Stripe dashboard;
  `enabled=false` only stops uploads.
- Other modules (spa, tours, golf …). Those are bookings, which Stripe
  treats as a separate "services" track.

## Data model

Migration `src/db/migrate-2026-10-09-agentic-commerce.sql` (idempotent),
mirrored in `schema.sql`:

```sql
ALTER TABLE property ADD COLUMN IF NOT EXISTS agentic_commerce JSONB;
ALTER TABLE proshop_order ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proshop_order_checkout_session
  ON proshop_order (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
```

`property.agentic_commerce` (NULL = off):

```json
{
  "enabled": true,
  "sanity_project_id": "a26xzsqt",
  "sanity_dataset": "production",
  "site_url": "https://willy-t-bvi.vercel.app",
  "brand": "Willy T"
}
```

These are pointers, not content. They are stored because the jobs run
with no request to relay them from (the same reasoning as the
`event_inquiry.branding` exception).

A non-null `proshop_order.stripe_checkout_session_id` marks an agent
order. Order list/detail responses add a derived
`channel: 'agent' | 'web'`; there is no channel column.

## Settings API and MCP

- `GET /api/property/agentic-commerce` returns the object, or `null`.
- `PUT /api/property/agentic-commerce`: `authenticateOrApiKey`, and staff
  sessions need the admin role, like `PUT /api/property/email-branding`.
  Every field is validated: `site_url` is http(s) with no trailing slash
  (stripped if given), `sanity_project_id` is `[a-z0-9]+`,
  `sanity_dataset` is `[a-z0-9_-]+`, and `brand` is 1–70 characters.
  `enabled: true` is rejected unless the other four fields are set and
  the property has a `stripe_secret_key`.
- MCP: `get_agentic_commerce`, `set_agentic_commerce`.
- Swagger entries for both routes.

## Catalog feed (`src/lib/agenticFeed.js`)

### Sources

- **OTA**: `proshop_item` rows for the property, `status = 'active'`.
  These supply `id, name, price, category, product_group, variant_label,
  stock_quantity`.
- **Sanity** (public, no token): a GET to
  `https://<project>.api.sanity.io/v2024-01-01/data/query/<dataset>`
  with:
  - `*[_type=="product"]{name, "slug": slug.current, description, features, image}`
  - `*[_type=="siteSettings"][0]{shopShippingCost, shopShippingCostByState}`
  - These match the `forge-astro-sanity-starter` schema
    (`studio/schemaTypes/product.ts`, `siteSettings.ts` in willy-t-bvi).

### Joining items to docs

The join is by name, normalised with `trim().toLowerCase()`, the same
rule as the site's `src/lib/products.ts`. If an item has no doc of its
own:

1. it borrows the doc of a sibling item with the same `product_group`
   whose `variant_label` has the same first option (the part before
   `" — "`, e.g. "Grey");
2. otherwise it borrows the doc of any sibling in the same group;
3. otherwise the item is left out of the feed and a warning is logged,
   matching the site, which shows no page for it.

On WillyT's live data today, 20 of the 26 active items match a doc
directly. The other 6 are rash-guard sizes (Grey and White in S, M and
XL), and each borrows its colour's L doc.

### Product feed row

| Feed field | Value |
|---|---|
| `id` | `proshop_item.id` without dashes (32 hex characters) |
| `title` | `name` |
| `description` | Sanity `description`, followed by `features` joined with `". "`. Falls back to `name` if both are empty. |
| `link` | `<site_url>/shop/<slug>/` |
| `image_link` | Sanity CDN URL built from the asset ref, like the site's `src/lib/sanity.ts` (`?w=1200&auto=format`) |
| `brand` | config `brand` |
| `mpn` | same as `id` (own-label merch: the venue is the manufacturer) |
| `product_category` | `category`, or `Merchandise` if null |
| `item_group_id` | `product_group`, cut to 70 characters (only when set) |
| `item_group_title` | `product_group` |
| `custom_variant_option_name_1` / `_value_1` | `Variant` / `variant_label` (only when set) |
| `price` | `<price, 2dp> <property.currency>`, e.g. `42.00 USD` |
| `availability` | `in_stock`, or `out_of_stock` when `stock_quantity = 0` |
| `inventory_not_tracked` | `true` when `stock_quantity IS NULL`, otherwise `false` |
| `inventory_quantity` | `stock_quantity` when tracked, otherwise blank |
| `shipping` | see below |
| `disable_checkout` | `true` when there is no shipping entry, otherwise blank |

**Shipping** comes from `siteSettings`:

- `shopShippingCost` becomes `US:ALL:Delivery::<cost> <CUR>`.
- Each `shopShippingCostByState[]` entry adds `US:<state>:Delivery::<cost> <CUR>`.

If `shopShippingCost` is unset, there is no shipping, and the item is
listed for discovery only, sending buyers to the site. WillyT today:
`US:ALL:Delivery::20.00 USD`.

**Inventory feed rows:** `id, availability, inventory_quantity`, for
**tracked items only**, because that feed requires a quantity on every
row. **Pricing feed rows:** `id, price`.

**CSV:** RFC 4180. Every field is quoted when it contains `,`, `"`, CR
or LF, with `"` doubled.

### Upload

The upload helper is `uploadFeed(stripeKey, feedType, mode, csv)`:

1. `POST https://api.stripe.com/v2/commerce/product_catalog/imports`
   with `Authorization: Bearer <key>`, `Stripe-Version: 2026-09-30.preview`
   and the body `{feed_type, mode, metadata: {file_name}}`.
2. `PUT` the CSV (`Content-Type: text/csv`) to
   `status_details.awaiting_upload.upload_url.url` straight away (the
   URL expires after 5 minutes).
3. Return the import id. The job logs it. Terminal status is checked in
   the Stripe dashboard (Feed history), or by `GET …/imports/{id}`
   during the sandbox test.

The preview `Stripe-Version` is one exported constant. Plain `fetch` is
used because the installed `stripe` package does not cover v2 commerce
imports (to confirm during planning; use the SDK if it does).

### Schedule

`startAgenticFeedJob()` is called from `server.js` and runs every 15
minutes, for each property where `agentic_commerce->>'enabled' = 'true'`:

- uploads `pricing` (upsert);
- uploads `inventory` (upsert), skipped when no item is tracked;
- uploads `product` in **replace** mode on the first run after boot,
  then once 24 hours have passed since that property's last product
  upload. The timestamp is held in memory, so a restart simply uploads
  again, which is harmless.

Replace mode makes the uploaded file the whole catalog, so deleted or
deactivated items leave the agent channel with no state kept in OTA.

Each property runs in its own `try`, so one venue's failure doesn't stop
the others. Failures are logged and the next run retries.

## Agent orders (`src/lib/agenticOrders.js`)

`startAgenticOrderJob()` runs every 5 minutes, for each enabled property:

1. **List sessions.**
   `stripe.checkout.sessions.list({ status: 'complete', created: { gt: now − 24h }, limit: 100, expand: ['data.line_items'] })`,
   using `autoPagingEach`. Line items are retrieved per session if the
   list can't expand them. The 24-hour lookback covers downtime; the
   unique index (step 3) makes repeats harmless.
2. **Keep agent orders only.** Map each line's
   `price.external_reference` (the feed `id`) back to a
   `proshop_item.id` for this property. A session with no matching line
   is skipped: it isn't an agent sale of this shop. The website pays
   through PaymentIntents and never creates Checkout Sessions, so this
   is a safeguard.
3. **Record the order, in one transaction.**
   - `INSERT INTO proshop_order … ON CONFLICT (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING RETURNING id`.
     If nothing is returned, the order already exists; stop.
   - `shop_id` is the property's first active shop by name. That's the
     first row of `GET /api/proshop/shops`, which is what the site uses:
     `WHERE status = 'active' AND property_id = $1 ORDER BY name LIMIT 1`.
     With no active shop, the session is skipped and a warning is logged.
   - `reference` comes from `generateOrderReference`.
   - Contact name, email and phone come from `customer_details`.
   - `shipping_address` is
     `collected_information.shipping_details` (name + address) formatted
     on one line, ending with the country.
   - Amounts are **what Stripe charged**, converted from minor units:
     `total_price ← amount_total`,
     `shipping_cost ← total_details.amount_shipping`,
     `tax_amount ← total_details.amount_tax`, and
     `items_subtotal ← amount_subtotal`.
   - `stripe_payment_intent_id ← payment_intent`, so staff can find and
     refund the charge.
   - `status = 'paid'`, `payment_status = 'paid'`.
   - One `proshop_order_item` per line: `item_id` (null if the item no
     longer exists), `item_name` (the line's description, or the item
     name), `unit_price ← price.unit_amount`, `quantity`, and `subtotal`.
4. **After commit, only for a newly inserted order**, the same follow-on
   steps as `confirmOrderPayment`: `decrementStockForItems`,
   `publishNewProshopOrder`, `emailOrderConfirmationInBackground`. These
   are moved out of `controllers/proshop.js` only as far as needed to be
   callable from the job (export them; no behaviour change).

Stock already at 0 stays at 0 (the decrement uses
`GREATEST(stock_quantity - n, 0)`). The order is still recorded, because
the guest has paid.

Stripe or DB errors for one session are logged and that session is
retried on the next sweep. Other sessions carry on.

## Files

- `src/db/migrate-2026-10-09-agentic-commerce.sql` (new), `src/db/schema.sql`
- `src/lib/agenticFeed.js` (new): Sanity fetch, join, rows, CSV, upload, job
- `src/lib/agenticOrders.js` (new): session → order, job
- `src/controllers/proshop.js`: export the three follow-on helpers; add
  `channel` to order responses
- `src/controllers/property.js`, `src/routes/property.js`: settings endpoints
- `src/server.js`: start both jobs
- `mcp-server/tools.js`, `src/docs/swagger.js`
- `scripts/check-agentic-commerce.js` (new)

## Testing

`scripts/check-agentic-commerce.js` uses plain asserts and runs with
`node -r dotenv/config`. DB cases run in a transaction that is rolled
back.

- **Feed rows** (pure functions, canned items, docs and settings):
  - dashes are stripped from ids;
  - a size variant borrows its same-colour sibling's doc, and an item
    with no doc is left out;
  - untracked stock gives `inventory_not_tracked=true` with a blank
    quantity; tracked stock of 0 gives `out_of_stock`;
  - shipping comes from the default and from per-state overrides, and
    `disable_checkout` is set when there is no cost;
  - CSV escaping handles commas, quotes and newlines;
  - only tracked items appear in the inventory feed.
- **Orders** (canned Checkout Session object, in a rolled-back transaction):
  - an agent session becomes a paid order with items, address, payment
    intent and Stripe's totals;
  - sweeping twice gives one order and decrements stock once;
  - a session with no feed ids is skipped;
  - a line for a deleted item is stored by name with a null `item_id`.

**Sandbox end to end** (WillyT's test key; nothing live):

1. Upload WillyT's real feed and poll the import to `succeeded`. On
   `succeeded_with_errors`, download the error file and fix the mapping
   until it's clean.
2. In the Stripe dashboard, open Agentic commerce, then View feed, then
   Test on a product, and complete a test purchase. The buyer email used
   there receives OTA's confirmation email, so use the user's own inbox,
   never a guest's.
3. Run the order sweep once. Check that the order appears with a
   reference, stock goes down where tracked, and the email arrives.

## The user's setup in WillyT's Stripe dashboard

1. Go to Agentic commerce, choose **Agentic commerce for retail**, and
   onboard as a seller.
2. Fill in the Stripe profile with the terms, privacy, returns and
   delivery policy URLs (`/terms-conditions/`, `/privacy/`,
   `/refund-and-exchange-policy/`, `/delivery-shipping-policy/` on
   `willy-t-bvi.vercel.app`).
3. Verify the `willy-t-bvi.vercel.app` domain.
4. Tax: no tax codes are sent. Stripe warns that incomplete tax setup
   can fail checkouts, so the sandbox test purchase is the check.
5. Request agent connections, after the sandbox test passes.

## Deploy order

Each step needs the user's OK:

1. Apply the migration to the live DB
   (`node scripts/run-migration.js …`) **before** pushing. Both jobs
   query the new columns when the server starts.
2. Push.
3. `set_agentic_commerce` for WillyT, with `enabled: true`.

## Risks

- **Preview API.** The imports endpoint and `Stripe-Version:
  2026-09-30.preview` may change. The version is one constant.
- **Tax** on a GB account selling USD to US buyers (see above).
- **Name join.** Renaming an item in OTA without renaming its Sanity doc
  drops that item from the feed, exactly as it drops off the site. A
  warning is logged.
