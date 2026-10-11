# Agentic Commerce for the Pro Shop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List a property's pro shop items in AI agents through Stripe's Agentic Commerce Suite, and record agent purchases as paid OTA pro shop orders. WillyT is the pilot.

**Architecture:**
- A 15-minute in-process job builds CSV feeds and uploads them to the venue's own Stripe account with the SDK's `v2.commerce.productCatalog.imports`. Each feed row is an active `proshop_item` joined by name to the venue site's public Sanity `product` docs.
- A 5-minute in-process job lists completed Checkout Sessions on that account and maps each line's `price.external_reference` (the feed `id`) back to `proshop_item`. It inserts a paid `proshop_order`, with a unique session ID so an order can't be recorded twice, then runs the same stock, live-feed and email steps as a website order.
- The config is a JSONB column on `property`.

**Tech Stack:** Node/Express, `pg`, `stripe@22.5.0` (already installed), Sanity HTTP query API (public, no token), plain `node:assert` check script.

**Spec:** `docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md`

**Refinements to the spec, found while planning** (Task 1 amends the spec to match):
1. **Uploads use the SDK, not raw `fetch`.** The spec said to confirm this during planning. `stripe@22.5.0` ships `stripe.v2.commerce.productCatalog.imports.create/retrieve` on its default API version `2026-07-29.dahlia`.
2. **`PUT /api/property/agentic-commerce` is staff-session + admin only, not the API-key rail.** Someone holding a leaked API key could otherwise point `sanity_project_id`/`site_url` at their own content, and ChatGPT would show their links and images under the venue's Stripe name. The ai-replies `mode` setting is kept off the API-key rail for the same reason. The GET stays on the API-key rail. `set_agentic_commerce` over MCP therefore needs a staff session (Bearer).
3. **Image URLs use `?w=1200&fm=jpg`, not `auto=format`.** Four of WillyT's 20 product images are stored as WebP, and the feed accepts only JPEG or PNG.

## Global Constraints

- Feed `id` = `proshop_item.id` with the dashes removed (32 hex characters). `mpn` = the same value.
- Price format: `<amount to 2 dp> <property.currency>`, e.g. `42.00 USD`.
- Product link: `<site_url>/shop/<slug>/` (trailing slash). `site_url` is stored without a trailing slash.
- Image: `https://cdn.sanity.io/images/<project>/<dataset>/<id>-<WxH>.<ext>?w=1200&fm=jpg`, built from the asset ref `image-<id>-<WxH>-<ext>`.
- Shipping: `US:ALL:Delivery::<cost> <CUR>`, plus `US:<state>:Delivery::<cost> <CUR>` for each override, comma-joined. With no `shopShippingCost`, the shipping field is empty and `disable_checkout=true`.
- Product feed: **replace** mode, on the first run after boot and then every 24 h per property. Pricing and inventory feeds: **upsert** every 15 minutes. Inventory rows are for tracked items only.
- Join items to docs by name, normalised with `trim().toLowerCase()`. Fallback order: a sibling in the same `product_group` with the same first option (the part of `variant_label` before `" — "`), then any sibling in the group, then leave the item out.
- Order amounts are what Stripe charged (minor units ÷ 100). Status is `paid`/`paid`.
- Checkout Session retrieve uses request option `apiVersion: '2025-12-15.preview'`. The guide uses it to expand line items with `price.external_reference`.
- Settings validation: `sanity_project_id` matches `^[a-z0-9]+$`, `sanity_dataset` matches `^[a-z0-9_-]+$`, `site_url` is http(s) with the trailing `/` stripped, `brand` is 1–70 characters after trimming. `enabled: true` requires all four, plus `stripe_secret_key` on the property.
- Commits go directly on `main` (user preference). End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never run the check script against a remote DB. It refuses `neon.tech`/`render.com` URLs.

## Review Focus

1. **Sanity is down or returns no docs.** A replace-mode product upload of an empty file would delete the whole catalog from Stripe. Expected: no product rows means throw and upload nothing. Pinned in Task 3.
2. **A Sanity description contains commas, quotes or newlines** (e.g. `Soft "vintage" fit, UPF 50+`). Expected: the CSV stays well-formed. Pinned in Task 2 (CSV escaping).
3. **A feature line already ends in a full stop** (e.g. `Machine washable.`). Expected: no `..` in the description. Pinned in Task 2.
4. **A session whose items were all deleted from OTA, or a non-agent session** (the venue uses Checkout elsewhere). Expected: skipped, with no order and no crash. Pinned in Task 4.
5. **The guest's name or a line description is longer than the column** (`contact_name`/`item_name` are VARCHAR(100)). Expected: truncated, not a failed insert that's retried forever. Pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrate-2026-10-09-agentic-commerce.sql` (new) | `property.agentic_commerce`, `proshop_order.stripe_checkout_session_id` + partial unique index |
| `src/db/schema.sql` | mirror of the above |
| `src/controllers/property.js` | `mergeAgenticCommerce` (pure), `getAgenticCommerce`, `updateAgenticCommerce` |
| `src/routes/property.js` | the two routes |
| `src/lib/agenticFeed.js` (new) | pure feed building (match, rows, CSV) + I/O (Sanity fetch, item load, upload, job) |
| `src/lib/agenticOrders.js` (new) | pure session → order mapping, `recordOrder(db, …)`, sweep job |
| `src/lib/orderReference.js` | gains `allocateOrderReference(db, propertyId)` (moved out of `createOrder`) |
| `src/controllers/proshop.js` | uses `allocateOrderReference`; exports follow-on helpers; `channel` on order responses |
| `src/server.js` | starts both jobs |
| `mcp-server/tools.js`, `src/docs/swagger.js` | tools + docs |
| `scripts/check-agentic-commerce.js` (new) | assert-based checks: pure functions + a rolled-back DB transaction |

---

### Task 1: Config: migration, settings API, MCP, docs

**Files:**
- Create: `src/db/migrate-2026-10-09-agentic-commerce.sql`, `scripts/check-agentic-commerce.js`
- Modify: `src/db/schema.sql`, `src/controllers/property.js`, `src/routes/property.js`, `mcp-server/tools.js`, `src/docs/swagger.js`, `docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md`

**Interfaces:**
- Produces: column `property.agentic_commerce JSONB` (shape `{enabled, sanity_project_id, sanity_dataset, site_url, brand}`); column `proshop_order.stripe_checkout_session_id`; `mergeAgenticCommerce(current, body) → { value } | { error }` exported from `src/controllers/property.js`; `scripts/check-agentic-commerce.js`, whose `check(name, fn)` harness later tasks append to.

- [ ] **Step 1: Write the migration**

`src/db/migrate-2026-10-09-agentic-commerce.sql`:

```sql
-- Agentic commerce (Stripe ACS) -- see
-- docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
-- property.agentic_commerce holds pointers only (Sanity project/dataset,
-- site URL, brand): the feed job runs with no request to relay them from.
-- NULL = off.
ALTER TABLE property ADD COLUMN IF NOT EXISTS agentic_commerce JSONB;

-- Set on orders bought through an AI agent; the unique index is what makes
-- re-sweeping the same Checkout Session a no-op.
ALTER TABLE proshop_order ADD COLUMN IF NOT EXISTS stripe_checkout_session_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proshop_order_checkout_session
  ON proshop_order (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
```

- [ ] **Step 2: Apply it locally, twice (idempotency)**

Run: `node -r dotenv/config -e "const p=require('./src/db');const s=require('fs').readFileSync('src/db/migrate-2026-10-09-agentic-commerce.sql','utf8');p.query(s).then(()=>p.query(s)).then(()=>{console.log('ok');p.end()})"`
Expected: `ok`. This touches **only** the local DB (`DATABASE_URL`). `scripts/run-migration.js` would also apply it to live, so don't use it here.

- [ ] **Step 3: Mirror it in `schema.sql`.** Add `agentic_commerce JSONB,` to `CREATE TABLE IF NOT EXISTS property`, after `stripe_terminal_location_id`, with the comment `-- Stripe agentic commerce pointers, NULL = off -- see migrate-2026-10-09-agentic-commerce.sql`. Add `stripe_checkout_session_id VARCHAR(255),` to `proshop_order`, after `stripe_payment_intent_id`, with `-- set on orders bought through an AI agent`. Add the `CREATE UNIQUE INDEX` after the proshop indexes.

- [ ] **Step 4: Write the failing check**

`scripts/check-agentic-commerce.js`:

```js
// Checks agentic commerce (Stripe ACS): settings validation, feed building,
// and session -> order recording. DB fixtures live inside one transaction
// that is rolled back, so nothing persists. Never point this at the live DB.
//   node -r dotenv/config scripts/check-agentic-commerce.js
delete process.env.RESEND_API_KEY;
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { mergeAgenticCommerce } = require('../src/controllers/property');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); await db.query('RELEASE SAVEPOINT c'); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); await db.query('ROLLBACK TO SAVEPOINT c'); }
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  try {
    const FULL = { sanity_project_id: 'a26xzsqt', sanity_dataset: 'production', site_url: 'https://willy-t-bvi.vercel.app', brand: 'Willy T' };

    await check('settings: full config can be enabled; site_url trailing slash stripped', async () => {
      const { value, error } = mergeAgenticCommerce(null, { ...FULL, site_url: 'https://willy-t-bvi.vercel.app/', enabled: true });
      assert.equal(error, undefined);
      assert.deepEqual(value, { ...FULL, enabled: true });
    });
    await check('settings: enabling with a field missing is rejected', async () => {
      assert.match(mergeAgenticCommerce(null, { ...FULL, brand: undefined, enabled: true }).error, /brand/);
    });
    await check('settings: omitted fields keep their stored value', async () => {
      const { value } = mergeAgenticCommerce({ ...FULL, enabled: true }, { brand: 'Willy-T' });
      assert.deepEqual(value, { ...FULL, brand: 'Willy-T', enabled: true });
    });
    await check('settings: bad values are rejected', async () => {
      assert.ok(mergeAgenticCommerce(null, { sanity_project_id: 'A26/x' }).error);
      assert.ok(mergeAgenticCommerce(null, { sanity_dataset: 'prod data' }).error);
      assert.ok(mergeAgenticCommerce(null, { site_url: 'javascript:alert(1)' }).error);
      assert.ok(mergeAgenticCommerce(null, { brand: '   ' }).error);
      assert.ok(mergeAgenticCommerce(null, { brand: 'x'.repeat(71) }).error);
      assert.ok(mergeAgenticCommerce(null, { enabled: 'yes' }).error);
    });

    // ── later tasks append checks above this line ──
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: a crash (`mergeAgenticCommerce is not a function`).

- [ ] **Step 6: Add the settings controller.** In `src/controllers/property.js`, near the email-branding handlers:

```js
// Stripe agentic commerce -- see
// docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
// Pointers only (where the feed reads product copy from, and the brand
// printed on it); the content itself stays in the venue's Sanity.
const AGENTIC_REQUIRED = ['sanity_project_id', 'sanity_dataset', 'site_url', 'brand'];

// Pure: a PUT body merged over the stored object. Per field: omit = unchanged.
// Returns { value } or { error }.
function mergeAgenticCommerce(current, body) {
  const next = { enabled: false, ...(current ?? {}) };
  const { enabled, sanity_project_id, sanity_dataset, site_url, brand } = body ?? {};
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    next.enabled = enabled;
  }
  if (sanity_project_id !== undefined) {
    if (typeof sanity_project_id !== 'string' || !/^[a-z0-9]+$/.test(sanity_project_id)) return { error: 'sanity_project_id must be lowercase letters and digits' };
    next.sanity_project_id = sanity_project_id;
  }
  if (sanity_dataset !== undefined) {
    if (typeof sanity_dataset !== 'string' || !/^[a-z0-9_-]+$/.test(sanity_dataset)) return { error: 'sanity_dataset must be lowercase letters, digits, _ or -' };
    next.sanity_dataset = sanity_dataset;
  }
  if (site_url !== undefined) {
    const url = typeof site_url === 'string' ? site_url.replace(/\/+$/, '') : '';
    if (!isValidUrl(url)) return { error: 'site_url must be an http(s) URL' };
    next.site_url = url;
  }
  if (brand !== undefined) {
    const b = typeof brand === 'string' ? brand.trim() : '';
    if (!b || b.length > 70) return { error: 'brand must be 1-70 characters' };
    next.brand = b;
  }
  if (next.enabled) {
    const missing = AGENTIC_REQUIRED.filter((k) => !next[k]);
    if (missing.length) return { error: `enabled needs ${missing.join(', ')} set` };
  }
  return { value: next };
}

async function getAgenticCommerce(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT agentic_commerce FROM property WHERE id = $1', [req.property_id]);
    res.json(rows[0].agentic_commerce ?? null);
  } catch (err) {
    next(err);
  }
}

async function updateAgenticCommerce(req, res, next) {
  try {
    const { rows: [p] } = await pool.query('SELECT agentic_commerce, stripe_secret_key FROM property WHERE id = $1', [req.property_id]);
    const { value, error } = mergeAgenticCommerce(p.agentic_commerce, req.body);
    if (error) return res.status(400).json({ error });
    if (value.enabled && !p.stripe_secret_key) return res.status(400).json({ error: 'enabled needs a Stripe secret key on this property' });
    const { rows } = await pool.query('UPDATE property SET agentic_commerce = $1 WHERE id = $2 RETURNING agentic_commerce', [value, req.property_id]);
    res.json(rows[0].agentic_commerce);
  } catch (err) {
    next(err);
  }
}
```

Add `mergeAgenticCommerce, getAgenticCommerce, updateAgenticCommerce` to the file's `module.exports`.

- [ ] **Step 7: Routes.** In `src/routes/property.js`, after the email-branding pair:

```js
// GET is on the API-key rail (read-only pointers). PUT is staff + admin
// only: whoever sets these chooses the copy, images and links ChatGPT shows
// under the venue's Stripe name -- same reasoning as ai-replies' mode.
router.get('/agentic-commerce', authenticateOrApiKey, ctrl.getAgenticCommerce);
router.put('/agentic-commerce', authenticate, requireRole('admin'), ctrl.updateAgenticCommerce);
```

- [ ] **Step 8: Run the check**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: 4 × `ok`, then `all passed`.

- [ ] **Step 9: MCP tools.** In `mcp-server/tools.js`, after `update_email_branding`:

```js
  {
    name: 'get_agentic_commerce',
    description: "The property's Stripe agentic-commerce settings (selling pro shop items through AI agents like ChatGPT): enabled, sanity_project_id, sanity_dataset, site_url, brand -- or null when never set up",
    inputSchema: {},
    run: () => apiRequest('GET', '/api/property/agentic-commerce'),
  },
  {
    name: 'set_agentic_commerce',
    description: "Set the property's Stripe agentic-commerce settings. Needs a staff admin session (Bearer), not an API key. Per field: omit to leave unchanged. enabled=true needs all four other fields and a Stripe secret key on the property. Product copy, images and pages are read from the venue's public Sanity; OTA stores only these pointers.",
    inputSchema: {
      enabled: z.boolean().optional(),
      sanity_project_id: z.string().optional().describe('Sanity project id of the venue site, e.g. a26xzsqt'),
      sanity_dataset: z.string().optional().describe('Sanity dataset, e.g. production'),
      site_url: z.string().optional().describe('Venue site base URL; product links are <site_url>/shop/<slug>/'),
      brand: z.string().optional().describe('Brand printed on every product, 1-70 characters'),
    },
    run: (args) => apiRequest('PUT', '/api/property/agentic-commerce', { body: args }),
  },
```

- [ ] **Step 10: Swagger.** In `src/docs/swagger.js`, before `'/api/property/email-branding'`:

```js
    '/api/property/agentic-commerce': {
      get: { tags: ['Property'], summary: 'Get Stripe agentic-commerce settings', security: [{ bearerAuth: [] }, { apiKeyAuth: [] }], responses: { 200: { description: '{ enabled, sanity_project_id, sanity_dataset, site_url, brand } or null' } } },
      put: { tags: ['Property'], summary: 'Update Stripe agentic-commerce settings (admin only)', description: 'Pointers for the agent catalog feed: product copy, images and pages come from the venue site\'s public Sanity. Per field: omit = unchanged. enabled=true needs every field plus a Stripe secret key.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { enabled: { type: 'boolean' }, sanity_project_id: { type: 'string', example: 'a26xzsqt' }, sanity_dataset: { type: 'string', example: 'production' }, site_url: { type: 'string', example: 'https://willy-t-bvi.vercel.app' }, brand: { type: 'string', example: 'Willy T' } } } } } }, responses: { 200: { description: 'Updated settings' }, 400: { description: 'Invalid field, or enabled without every field / a Stripe key' }, 403: { description: 'Admin role required' } } },
    },
```

- [ ] **Step 11: Try it over HTTP.** Start the server with `PORT=3999 node -r dotenv/config src/server.js` in the background. With a local property's API key:
  - `curl -s -H "X-Api-Key: $K" localhost:3999/api/property/agentic-commerce` → `null`
  - `curl -s -X PUT -H "X-Api-Key: $K" -H 'Content-Type: application/json' -d '{"brand":"x"}' localhost:3999/api/property/agentic-commerce` → 401 (an API key isn't enough).

  Stop the server afterwards.

- [ ] **Step 12: Amend the spec to match.** In `docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md`:
  - Settings API: make PUT `authenticate` + `requireRole('admin')` and add the leaked-key reasoning.
  - Upload: replace the "Plain `fetch` …" paragraph with "Uses `stripe.v2.commerce.productCatalog.imports.create` (stripe@22.5.0, default API version); the CSV PUT to the presigned URL is plain `fetch`."
  - `image_link`: `?w=1200&fm=jpg` (some originals are WebP).
  - Deploy step 3: `set_agentic_commerce` needs a staff admin session.

- [ ] **Step 13: Commit**

```bash
git add src/db/migrate-2026-10-09-agentic-commerce.sql src/db/schema.sql src/controllers/property.js src/routes/property.js mcp-server/tools.js src/docs/swagger.js scripts/check-agentic-commerce.js docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md
git commit -m "Agentic commerce: settings column, API, MCP tools; session id on proshop_order

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Feed builder (pure)

**Files:**
- Create: `src/lib/agenticFeed.js`
- Modify: `scripts/check-agentic-commerce.js`

**Interfaces:**
- Consumes: the settings shape from Task 1.
- Produces, exported from `src/lib/agenticFeed.js`:
  - `feedId(uuid: string) → string`
  - `matchDocs(items, docs) → Map<itemId, doc>`
  - `shippingEntries(settings, currency) → string` (`''` = none)
  - `buildFeeds({ items, docs, settings, config, currency }) → { product: Row[], inventory: Row[], pricing: Row[], skipped: string[] }`
  - `toCsv(rows, columns) → string`
  - `PRODUCT_COLUMNS`, `INVENTORY_COLUMNS`, `PRICING_COLUMNS`

  `items` rows are `{ id, name, price, category, product_group, variant_label, stock_quantity }`. `docs` are `{ name, slug, description, features, image: { asset: { _ref } } }`. `settings` is `{ shopShippingCost, shopShippingCostByState: [{ state, cost }] } | null`. `config` is the Task 1 settings object.

- [ ] **Step 1: Write the failing checks.** In `scripts/check-agentic-commerce.js`, add `const feed = require('../src/lib/agenticFeed');` under the other requires, and before the `// ── later tasks append` line add:

```js
    const CFG = { sanity_project_id: 'a26xzsqt', sanity_dataset: 'production', site_url: 'https://willy-t-bvi.vercel.app', brand: 'Willy T' };
    const IMG = { asset: { _ref: 'image-abc123-800x800-webp' } };
    const item = (o) => ({ id: '11111111-2222-3333-4444-555555555555', name: 'Burgee', price: '20.00', category: 'Flags', product_group: null, variant_label: null, stock_quantity: null, ...o });
    const doc = (o) => ({ name: 'Burgee', slug: 'burgee', description: 'Flag of the bar', features: [], image: IMG, ...o });

    await check('feed: id strips dashes; standalone item row', async () => {
      const { product } = feed.buildFeeds({ items: [item()], docs: [doc()], settings: { shopShippingCost: 20 }, config: CFG, currency: 'USD' });
      assert.equal(product.length, 1);
      const r = product[0];
      assert.equal(r.id, '11111111222233334444555555555555');
      assert.equal(r.mpn, r.id);
      assert.equal(r.link, 'https://willy-t-bvi.vercel.app/shop/burgee/');
      assert.equal(r.image_link, 'https://cdn.sanity.io/images/a26xzsqt/production/abc123-800x800.webp?w=1200&fm=jpg');
      assert.equal(r.price, '20.00 USD');
      assert.equal(r.brand, 'Willy T');
      assert.equal(r.product_category, 'Flags');
      assert.equal(r.item_group_id, '');
      assert.equal(r.shipping, 'US:ALL:Delivery::20.00 USD');
      assert.equal(r.disable_checkout, '');
    });
    await check('feed: name join ignores case and whitespace', async () => {
      const { product } = feed.buildFeeds({ items: [item({ name: '  BURGEE ' })], docs: [doc()], settings: null, config: CFG, currency: 'USD' });
      assert.equal(product.length, 1);
    });
    await check('feed: size variant borrows same-colour sibling doc; no doc anywhere = skipped', async () => {
      const g = 'Rash Guard Long Sleeve UPF 50+';
      const items = [
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000001', name: `${g} — Grey — L`, product_group: g, variant_label: 'Grey — L' }),
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000002', name: `${g} — White — L`, product_group: g, variant_label: 'White — L' }),
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000003', name: `${g} — White — S`, product_group: g, variant_label: 'White — S' }),
        item({ id: 'aaaaaaaa-0000-0000-0000-000000000004', name: 'Mystery Mug' }),
      ];
      const docs = [doc({ name: `${g} — Grey — L`, slug: 'grey' }), doc({ name: `${g} — White — L`, slug: 'white' })];
      const { product, skipped } = feed.buildFeeds({ items, docs, settings: null, config: CFG, currency: 'USD' });
      assert.equal(product.find((r) => r.title.endsWith('White — S')).link, 'https://willy-t-bvi.vercel.app/shop/white/');
      assert.deepEqual(skipped, ['Mystery Mug']);
      assert.equal(product[0].item_group_id, g);
      assert.equal(product[0].custom_variant_option_name_1, 'Variant');
      assert.equal(product[0].custom_variant_option_value_1, 'Grey — L');
    });
    await check('feed: stock -- untracked, tracked, sold out; inventory feed = tracked only', async () => {
      const items = [
        item({ id: 'bbbbbbbb-0000-0000-0000-000000000001', name: 'A', stock_quantity: null }),
        item({ id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'B', stock_quantity: 5 }),
        item({ id: 'bbbbbbbb-0000-0000-0000-000000000003', name: 'C', stock_quantity: 0 }),
      ];
      const docs = ['A', 'B', 'C'].map((n) => doc({ name: n, slug: n.toLowerCase() }));
      const { product, inventory, pricing } = feed.buildFeeds({ items, docs, settings: null, config: CFG, currency: 'USD' });
      const [a, b, c] = product;
      assert.deepEqual([a.inventory_not_tracked, a.inventory_quantity, a.availability], ['true', '', 'in_stock']);
      assert.deepEqual([b.inventory_not_tracked, b.inventory_quantity, b.availability], ['false', '5', 'in_stock']);
      assert.deepEqual([c.inventory_not_tracked, c.inventory_quantity, c.availability], ['false', '0', 'out_of_stock']);
      assert.deepEqual(inventory.map((r) => r.inventory_quantity), ['5', '0']);
      assert.equal(pricing.length, 3);
    });
    await check('feed: shipping overrides per state; no cost = discovery only', async () => {
      assert.equal(feed.shippingEntries({ shopShippingCost: 20, shopShippingCostByState: [{ state: 'AK', cost: 45 }] }, 'USD'),
        'US:ALL:Delivery::20.00 USD,US:AK:Delivery::45.00 USD');
      assert.equal(feed.shippingEntries({ shopShippingCost: 0 }, 'USD'), 'US:ALL:Delivery::0.00 USD');
      const { product } = feed.buildFeeds({ items: [item()], docs: [doc()], settings: {}, config: CFG, currency: 'USD' });
      assert.equal(product[0].shipping, '');
      assert.equal(product[0].disable_checkout, 'true');
    });
    await check('feed: description joins features without doubled full stops; falls back to name', async () => {
      const { product } = feed.buildFeeds({ items: [item()], docs: [doc({ description: 'Flag of the bar.', features: ['Machine washable.', ' 12 x 18 in '] })], settings: null, config: CFG, currency: 'USD' });
      assert.equal(product[0].description, 'Flag of the bar. Machine washable. 12 x 18 in');
      const bare = feed.buildFeeds({ items: [item()], docs: [doc({ description: null, features: null })], settings: null, config: CFG, currency: 'USD' });
      assert.equal(bare.product[0].description, 'Burgee');
    });
    await check('feed: CSV quotes commas, quotes and newlines', async () => {
      const csv = feed.toCsv([{ id: 'x', title: 'Soft "vintage" fit, UPF 50+', description: 'line1\nline2' }], ['id', 'title', 'description']);
      assert.equal(csv, 'id,title,description\r\nx,"Soft ""vintage"" fit, UPF 50+","line1\nline2"\r\n');
    });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: a crash (`Cannot find module '../src/lib/agenticFeed'`).

- [ ] **Step 3: Write `src/lib/agenticFeed.js` (pure part)**

```js
// Stripe agentic commerce catalog feed -- see
// docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
// One row per active proshop_item, joined by name to the venue site's
// public Sanity `product` docs (copy, image, page). OTA stores none of that
// content; the site doesn't change.

const PRODUCT_COLUMNS = [
  'id', 'title', 'description', 'link', 'image_link', 'brand', 'mpn', 'product_category',
  'item_group_id', 'item_group_title', 'custom_variant_option_name_1', 'custom_variant_option_value_1',
  'price', 'availability', 'inventory_not_tracked', 'inventory_quantity', 'shipping', 'disable_checkout',
];
const INVENTORY_COLUMNS = ['id', 'availability', 'inventory_quantity'];
const PRICING_COLUMNS = ['id', 'price'];

const feedId = (uuid) => uuid.replace(/-/g, '');
const norm = (s) => String(s ?? '').trim().toLowerCase();
// "Grey — L" -> "Grey": the option the site's per-colour product docs differ by.
const firstOption = (label) => String(label ?? '').split(' — ')[0].trim();
const money = (n, currency) => `${Number(n).toFixed(2)} ${currency}`;
const availability = (item) => (item.stock_quantity === 0 ? 'out_of_stock' : 'in_stock');

// Same join as the site (willy-t-bvi src/lib/products.ts): by normalised
// name. Size variants have no doc of their own, so they borrow a sibling's --
// same colour first, then any sibling in the group.
function matchDocs(items, docs) {
  const byName = new Map(docs.map((d) => [norm(d.name), d]));
  const own = new Map(items.map((i) => [i.id, byName.get(norm(i.name))]));
  const matched = new Map();
  for (const item of items) {
    let doc = own.get(item.id);
    if (!doc && item.product_group) {
      const siblings = items.filter((s) => s.id !== item.id && s.product_group === item.product_group && own.get(s.id));
      const sameOption = siblings.find((s) => firstOption(s.variant_label) === firstOption(item.variant_label));
      doc = own.get((sameOption ?? siblings[0])?.id);
    }
    if (doc) matched.set(item.id, doc);
  }
  return matched;
}

// fm=jpg: the feed takes JPEG/PNG only, and some originals are WebP.
function imageUrl(config, image) {
  const [, id, dims, ext] = String(image?.asset?._ref ?? '').split('-');
  if (!id || !dims || !ext) return '';
  return `https://cdn.sanity.io/images/${config.sanity_project_id}/${config.sanity_dataset}/${id}-${dims}.${ext}?w=1200&fm=jpg`;
}

// siteSettings.shopShippingCost (flat US rate) + per-state overrides. US
// only, because that's all the site delivers to.
function shippingEntries(settings, currency) {
  if (settings?.shopShippingCost == null) return '';
  const entries = [`US:ALL:Delivery::${money(settings.shopShippingCost, currency)}`];
  for (const o of settings.shopShippingCostByState ?? []) entries.push(`US:${o.state}:Delivery::${money(o.cost, currency)}`);
  return entries.join(',');
}

function describe(doc, fallback) {
  const parts = [doc.description, ...(doc.features ?? [])]
    .map((s) => String(s ?? '').trim().replace(/\.+$/, ''))
    .filter(Boolean);
  return parts.join('. ') || fallback;
}

function buildFeeds({ items, docs, settings, config, currency }) {
  const matched = matchDocs(items, docs);
  const shipping = shippingEntries(settings, currency);
  const included = items.filter((i) => matched.has(i.id));
  const product = included.map((i) => {
    const doc = matched.get(i.id);
    const tracked = i.stock_quantity != null;
    return {
      id: feedId(i.id),
      title: i.name,
      description: describe(doc, i.name),
      link: `${config.site_url}/shop/${doc.slug}/`,
      image_link: imageUrl(config, doc.image),
      brand: config.brand,
      mpn: feedId(i.id), // own-label merch: the venue is the manufacturer
      product_category: i.category || 'Merchandise',
      item_group_id: i.product_group ? i.product_group.slice(0, 70) : '',
      item_group_title: i.product_group ?? '',
      custom_variant_option_name_1: i.variant_label ? 'Variant' : '',
      custom_variant_option_value_1: i.variant_label ?? '',
      price: money(i.price, currency),
      availability: availability(i),
      inventory_not_tracked: tracked ? 'false' : 'true',
      inventory_quantity: tracked ? String(i.stock_quantity) : '',
      shipping,
      disable_checkout: shipping ? '' : 'true',
    };
  });
  // The inventory feed requires a quantity on every row: tracked items only.
  const inventory = included
    .filter((i) => i.stock_quantity != null)
    .map((i) => ({ id: feedId(i.id), availability: availability(i), inventory_quantity: String(i.stock_quantity) }));
  const pricing = included.map((i) => ({ id: feedId(i.id), price: money(i.price, currency) }));
  const skipped = items.filter((i) => !matched.has(i.id)).map((i) => i.name);
  return { product, inventory, pricing, skipped };
}

const cell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = {
  PRODUCT_COLUMNS, INVENTORY_COLUMNS, PRICING_COLUMNS,
  feedId, matchDocs, shippingEntries, buildFeeds, toCsv,
};
```

- [ ] **Step 4: Run the checks**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: 11 × `ok`, then `all passed`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenticFeed.js scripts/check-agentic-commerce.js
git commit -m "Agentic commerce: build product/inventory/pricing feeds from OTA items + Sanity docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Feed upload and the 15-minute job

**Files:**
- Modify: `src/lib/agenticFeed.js`, `src/server.js`, `scripts/check-agentic-commerce.js`

**Interfaces:**
- Consumes: `buildFeeds`, `toCsv`, `*_COLUMNS` (Task 2).
- Produces, exported from `src/lib/agenticFeed.js`:
  - `enabledProperties(db) → [{ id, name, currency, stripe_secret_key, agentic_commerce }]`
  - `uploadFeed(stripe, feedType, mode, csv) → importId`
  - `syncProperty(property, { stripe, fetchSanity, now }?) → [[feedType, importId], …]`
  - `startAgenticFeedJob()`

  Task 4 uses `enabledProperties`.

- [ ] **Step 1: Write the failing checks.** Before the `// ── later tasks append` line:

```js
    await check('sync: first run uploads product (replace) then pricing + inventory (upsert)', async () => {
      const prop = await one(`INSERT INTO property (name, currency, timezone, stripe_secret_key, agentic_commerce)
        VALUES ('Feed Check', 'USD', 'America/Tortola', 'sk_test_fake', $1) RETURNING *`, [{ ...CFG, enabled: true }]);
      await db.query(`INSERT INTO proshop_item (property_id, name, price, stock_quantity) VALUES ($1, 'Burgee', 20, 3), ($1, 'Unknown', 9, NULL)`, [prop.id]);
      const calls = [];
      const stripe = { v2: { commerce: { productCatalog: { imports: { create: async (p) => { calls.push(p); return { id: `imp_${calls.length}`, status: 'awaiting_upload', status_details: { awaiting_upload: { upload_url: { url: 'https://upload.test/x' } } } }; } } } } } };
      const puts = [];
      const realFetch = global.fetch;
      global.fetch = async (url, opts) => { puts.push(opts.body); return { ok: true, status: 200 }; };
      try {
        const out = await feed.syncProperty(prop, { db, stripe, fetchSanity: async () => ({ docs: [doc()], settings: { shopShippingCost: 20 } }), now: 1_000 });
        assert.deepEqual(out.map(([t]) => t), ['product', 'pricing', 'inventory']);
        assert.deepEqual(calls.map((c) => [c.feed_type, c.mode]), [['product', 'replace'], ['pricing', 'upsert'], ['inventory', 'upsert']]);
        assert.match(puts[0], /^id,title,/);
        assert.equal(puts[0].trim().split('\r\n').length, 2); // header + Burgee; 'Unknown' has no doc
        const again = await feed.syncProperty(prop, { db, stripe, fetchSanity: async () => ({ docs: [doc()], settings: { shopShippingCost: 20 } }), now: 2_000 });
        assert.deepEqual(again.map(([t]) => t), ['pricing', 'inventory']); // product only every 24 h
      } finally { global.fetch = realFetch; }
    });
    await check('sync: no Sanity docs = refuse (a replace upload would empty the catalog)', async () => {
      const prop = await one(`INSERT INTO property (name, currency, timezone, stripe_secret_key, agentic_commerce)
        VALUES ('Feed Check 2', 'USD', 'America/Tortola', 'sk_test_fake', $1) RETURNING *`, [{ ...CFG, enabled: true }]);
      await db.query(`INSERT INTO proshop_item (property_id, name, price) VALUES ($1, 'Burgee', 20)`, [prop.id]);
      const stripe = { v2: { commerce: { productCatalog: { imports: { create: async () => { throw new Error('must not upload'); } } } } } };
      await assert.rejects(feed.syncProperty(prop, { db, stripe, fetchSanity: async () => ({ docs: [], settings: null }), now: 1_000 }), /no products/);
    });
```

- [ ] **Step 2: Run and confirm failure**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: the two `sync:` checks FAIL (`feed.syncProperty is not a function`).

- [ ] **Step 3: Add the I/O half to `src/lib/agenticFeed.js`.** Add `const pool = require('../db');` at the top. Insert this above `module.exports`:

```js
const SANITY_API_VERSION = '2024-01-01';
const DAY_MS = 24 * 60 * 60 * 1000;

// Public dataset, no token: the same published content the site renders.
async function fetchSanity(config) {
  const query = `{"docs": *[_type=="product"]{name, "slug": slug.current, description, features, image},
    "settings": *[_type=="siteSettings"][0]{shopShippingCost, shopShippingCostByState}}`;
  const url = `https://${config.sanity_project_id}.api.sanity.io/v${SANITY_API_VERSION}/data/query/${config.sanity_dataset}?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sanity query failed: ${res.status}`);
  const { result } = await res.json();
  return { docs: result?.docs ?? [], settings: result?.settings ?? null };
}

async function loadItems(db, propertyId) {
  const { rows } = await db.query(
    `SELECT id, name, price, category, product_group, variant_label, stock_quantity
     FROM proshop_item WHERE property_id = $1 AND status = 'active' ORDER BY name`,
    [propertyId]
  );
  return rows;
}

async function enabledProperties(db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, currency, stripe_secret_key, agentic_commerce FROM property
     WHERE (agentic_commerce->>'enabled')::boolean IS TRUE AND stripe_secret_key IS NOT NULL`
  );
  return rows;
}

// Create the import, then PUT the CSV to its presigned URL (valid 5 min).
// Processing is async on Stripe's side; terminal status is in the
// dashboard's Feed history.
async function uploadFeed(stripe, feedType, mode, csv) {
  const imp = await stripe.v2.commerce.productCatalog.imports.create({
    feed_type: feedType, mode, metadata: { file_name: `ota-${feedType}-${new Date().toISOString()}.csv` },
  });
  const url = imp.status_details?.awaiting_upload?.upload_url?.url;
  if (!url) throw new Error(`Import ${imp.id} has no upload URL (status ${imp.status})`);
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csv });
  if (!res.ok) throw new Error(`Upload for import ${imp.id} failed: ${res.status}`);
  return imp.id;
}

// In memory: a restart just re-uploads the product feed, which is harmless.
const lastProductUpload = new Map();

async function syncProperty(property, { db = pool, stripe = require('stripe')(property.stripe_secret_key), fetchSanity: fetchContent = fetchSanity, now = Date.now() } = {}) {
  const config = property.agentic_commerce;
  const [{ docs, settings }, items] = await Promise.all([fetchContent(config), loadItems(db, property.id)]);
  const feeds = buildFeeds({ items, docs, settings, config, currency: property.currency });
  // Replace mode deletes whatever the file leaves out -- an empty file (Sanity
  // down, every name renamed) would wipe the catalog. Upload nothing instead.
  if (!feeds.product.length) throw new Error('no products matched Sanity docs; nothing uploaded');
  if (feeds.skipped.length) console.warn(`Agentic feed ${property.name}: no Sanity doc for ${feeds.skipped.join(', ')}`);

  const uploaded = [];
  const last = lastProductUpload.get(property.id);
  if (last == null || now - last >= DAY_MS) {
    uploaded.push(['product', await uploadFeed(stripe, 'product', 'replace', toCsv(feeds.product, PRODUCT_COLUMNS))]);
    lastProductUpload.set(property.id, now);
  }
  uploaded.push(['pricing', await uploadFeed(stripe, 'pricing', 'upsert', toCsv(feeds.pricing, PRICING_COLUMNS))]);
  if (feeds.inventory.length) uploaded.push(['inventory', await uploadFeed(stripe, 'inventory', 'upsert', toCsv(feeds.inventory, INVENTORY_COLUMNS))]);
  return uploaded;
}

async function sweepFeeds() {
  for (const p of await enabledProperties()) {
    try {
      const uploaded = await syncProperty(p);
      console.log(`Agentic feed ${p.name}: ${uploaded.map(([t, id]) => `${t} ${id}`).join(', ')}`);
    } catch (err) {
      console.error(`Agentic feed ${p.name} failed:`, err.message);
    }
  }
}

function startAgenticFeedJob() {
  const run = () => sweepFeeds().catch((err) => console.error('Agentic feed sweep failed:', err.message));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}
```

Extend `module.exports` with `enabledProperties, uploadFeed, syncProperty, startAgenticFeedJob`.

- [ ] **Step 4: Run the checks**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: 13 × `ok`, then `all passed`.

- [ ] **Step 5: Start the job.** In `src/server.js`, add `const { startAgenticFeedJob } = require('./lib/agenticFeed');` beside the other job requires, and call `startAgenticFeedJob();` after `startReviewRequestJob();`.

- [ ] **Step 6: Boot check.** Run `PORT=3999 node -r dotenv/config src/server.js` for about 10 seconds. Expected: it starts with no `Agentic feed` errors, because no local property is enabled. Stop it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agenticFeed.js src/server.js scripts/check-agentic-commerce.js
git commit -m "Agentic commerce: upload feeds to the venue's Stripe every 15 min (product daily, replace)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Agent orders sweep

**Files:**
- Create: `src/lib/agenticOrders.js`
- Modify: `src/lib/orderReference.js`, `src/controllers/proshop.js`, `src/server.js`, `scripts/check-agentic-commerce.js`

**Interfaces:**
- Consumes: `enabledProperties`, `feedId` (Tasks 2–3); `decrementStockForItems(items)`, `emailOrderConfirmationInBackground(orderId, propertyId)`, `forFeed(order)` from `src/controllers/proshop.js` (exported by this task); `publishNewProshopOrder(propertyId, order)` from `src/lib/ably.js`.
- Produces:
  - `allocateOrderReference(db, propertyId) → string` in `src/lib/orderReference.js`
  - From `src/lib/agenticOrders.js`: `sessionToOrder(session, itemsByFeedId) → { order, lines } | null`, `recordOrder(db, propertyId, shopId, mapped) → order-with-items | null`, `startAgenticOrderJob()`
  - `channel: 'agent' | 'web'` on order responses

- [ ] **Step 1: Write the failing checks.** Add `const agentic = require('../src/lib/agenticOrders');` under the requires. Before the `// ── later tasks append` line:

```js
    const session = (o) => ({
      id: 'cs_test_1', amount_total: 6200, amount_subtotal: 4200,
      total_details: { amount_shipping: 2000, amount_tax: 0 },
      customer_details: { name: 'Pat Buyer', email: 'pat@example.com', phone: '+15551234567' },
      collected_information: { shipping_details: { name: 'Pat Buyer', address: { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' } } },
      payment_intent: 'pi_test_1',
      line_items: { data: [{ description: 'Burgee', quantity: 2, price: { unit_amount: 2100, external_reference: '11111111222233334444555555555555' } }] },
      ...o,
    });
    const BURGEE = { id: '11111111-2222-3333-4444-555555555555', name: 'Burgee' };
    const byFeed = new Map([['11111111222233334444555555555555', BURGEE]]);

    await check('orders: session maps to order + lines with Stripe amounts', async () => {
      const { order, lines } = agentic.sessionToOrder(session(), byFeed);
      assert.deepEqual(order, {
        contact_name: 'Pat Buyer', contact_email: 'pat@example.com', contact_phone: '+15551234567',
        shipping_address: 'Pat Buyer, 1 Main St, Austin, TX 78701, US',
        shipping_cost: 20, tax_amount: 0, items_subtotal: 42, total_price: 62,
        stripe_payment_intent_id: 'pi_test_1', stripe_checkout_session_id: 'cs_test_1',
      });
      assert.deepEqual(lines, [{ item_id: BURGEE.id, item_name: 'Burgee', unit_price: 21, quantity: 2, subtotal: 42 }]);
    });
    await check('orders: no line matches this shop = not ours (null)', async () => {
      assert.equal(agentic.sessionToOrder(session({ line_items: { data: [{ description: 'Gift card', quantity: 1, price: { unit_amount: 500, external_reference: null } }] } }), byFeed), null);
      assert.equal(agentic.sessionToOrder(session({ line_items: { data: [] } }), byFeed), null);
    });
    await check('orders: a deleted item is kept by name; over-long names truncated', async () => {
      const long = 'N'.repeat(150);
      const { order, lines } = agentic.sessionToOrder(session({
        customer_details: { name: long, email: 'pat@example.com' },
        line_items: { data: [
          { description: 'Burgee', quantity: 1, price: { unit_amount: 2100, external_reference: '11111111222233334444555555555555' } },
          { description: long, quantity: 1, price: { unit_amount: 500, external_reference: 'ffffffffffffffffffffffffffffffff' } },
        ] },
      }), byFeed);
      assert.equal(order.contact_name.length, 100);
      assert.equal(lines[1].item_id, null);
      assert.equal(lines[1].item_name.length, 100);
    });
    await check('orders: recordOrder inserts a paid order once; second call is a no-op', async () => {
      const prop = await one(`INSERT INTO property (name, currency, timezone) VALUES ('Order Check', 'USD', 'America/Tortola') RETURNING id`);
      const shop = await one(`INSERT INTO shop (property_id, name) VALUES ($1, 'Merch') RETURNING id`, [prop.id]);
      const it = await one(`INSERT INTO proshop_item (property_id, shop_id, name, price) VALUES ($1, $2, 'Burgee', 21) RETURNING id, name`, [prop.id, shop.id]);
      const mapped = agentic.sessionToOrder(session({ id: 'cs_test_rec' }), new Map([[feed.feedId(it.id), it]]));
      const first = await agentic.recordOrder(db, prop.id, shop.id, mapped);
      assert.equal(first.status, 'paid');
      assert.equal(first.payment_status, 'paid');
      assert.equal(first.stripe_checkout_session_id, 'cs_test_rec');
      assert.equal(first.reference.length > 0, true);
      assert.equal(first.items.length, 1);
      const n = await one(`SELECT count(*)::int AS n FROM proshop_order_item WHERE order_id = $1`, [first.id]);
      assert.equal(n.n, 1);
      assert.equal(await agentic.recordOrder(db, prop.id, shop.id, mapped), null);
      const orders = await one(`SELECT count(*)::int AS n FROM proshop_order WHERE stripe_checkout_session_id = 'cs_test_rec'`);
      assert.equal(orders.n, 1);
    });
```

- [ ] **Step 2: Run and confirm failure**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: a crash (`Cannot find module '../src/lib/agenticOrders'`).

- [ ] **Step 3: Move reference allocation into `src/lib/orderReference.js`.** Add:

```js
// Picks a reference not yet used by this property. Checked first rather than
// caught on the unique index, because a unique-violation would abort the
// caller's transaction.
async function allocateOrderReference(db, propertyId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateOrderReference();
    const { rows } = await db.query('SELECT 1 FROM proshop_order WHERE property_id = $1 AND reference = $2', [propertyId, candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error('Could not allocate an order reference');
}
```

Export it beside `generateOrderReference`. In `src/controllers/proshop.js` `createOrder`, replace the `let reference; for (…) {…} if (!reference) throw …` block with `const reference = await allocateOrderReference(client, req.property_id);`, and change the import to `const { allocateOrderReference } = require('../lib/orderReference');`. Keep `generateOrderReference` in the import if anything else in the file still uses it (grep first).

- [ ] **Step 4: Export the follow-on helpers and add `channel`.** In `src/controllers/proshop.js`:
  - `forFeed` becomes:

    ```js
    // channel: an order bought through an AI agent carries its Checkout Session id.
    function withChannel(order) {
      return { ...order, channel: order.stripe_checkout_session_id ? 'agent' : 'web' };
    }

    function forFeed(order) {
      return { ...withChannel(order), fulfillment_method: order.shipping_address ? 'shipping' : 'pickup' };
    }
    ```
  - In `listOrders`, replace `res.json(orders);` with `res.json(orders.map(withChannel));`.
  - In `getOrder`, replace `res.json(order);` with `res.json(withChannel(order));`.
  - Add `decrementStockForItems, emailOrderConfirmationInBackground, forFeed,` to `module.exports`, with the comment `// used by lib/agenticOrders.js`.

- [ ] **Step 5: Write `src/lib/agenticOrders.js`**

```js
// Agent purchases -> paid pro shop orders -- see
// docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
// Polls the venue's own Stripe account (no webhook to register per venue)
// for completed Checkout Sessions whose lines carry this shop's feed ids.
const pool = require('../db');
const { allocateOrderReference } = require('./orderReference');
const { publishNewProshopOrder } = require('./ably');
const { enabledProperties, feedId } = require('./agenticFeed');

// The seller guide expands line items with this preview version to get
// price.external_reference (the feed id).
const SESSION_API_VERSION = '2025-12-15.preview';
const LOOKBACK_SECONDS = 24 * 60 * 60;
const cents = (n) => (n ?? 0) / 100; // ponytail: 2-decimal currencies only; WillyT is USD
const cap = (s, n) => (s == null ? s : String(s).slice(0, n));

function formatAddress(details) {
  const a = details?.address;
  if (!a) return null;
  return [details.name, a.line1, a.line2, a.city, [a.state, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean).join(', ');
}

// Pure. null = no line is one of this property's feed items (not ours).
function sessionToOrder(session, itemsByFeedId) {
  const lines = (session.line_items?.data ?? []).map((li) => {
    const item = itemsByFeedId.get(li.price?.external_reference);
    const unit = cents(li.price?.unit_amount);
    return {
      item_id: item?.id ?? null,
      item_name: cap(item?.name ?? li.description ?? 'Item', 100),
      unit_price: unit,
      quantity: li.quantity,
      subtotal: Math.round(unit * li.quantity * 100) / 100,
    };
  });
  if (!lines.some((l) => l.item_id)) return null;
  const c = session.customer_details ?? {};
  const ship = session.collected_information?.shipping_details;
  return {
    order: {
      contact_name: cap(c.name || ship?.name || 'Agent Guest', 100),
      contact_email: c.email ?? null,
      contact_phone: cap(c.phone ?? null, 30),
      shipping_address: formatAddress(ship),
      shipping_cost: cents(session.total_details?.amount_shipping),
      tax_amount: cents(session.total_details?.amount_tax),
      items_subtotal: cents(session.amount_subtotal),
      total_price: cents(session.amount_total),
      stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      stripe_checkout_session_id: session.id,
    },
    lines,
  };
}

// Caller owns the transaction. null = this session was already recorded.
async function recordOrder(db, propertyId, shopId, { order, lines }) {
  const reference = await allocateOrderReference(db, propertyId);
  const { rows: [row] } = await db.query(
    `INSERT INTO proshop_order
       (property_id, shop_id, reference, contact_name, contact_email, contact_phone, shipping_address,
        shipping_cost, items_subtotal, tax_amount, total_price, status, payment_status,
        stripe_payment_intent_id, stripe_checkout_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'paid', 'paid', $12, $13)
     ON CONFLICT (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [propertyId, shopId, reference, order.contact_name, order.contact_email, order.contact_phone, order.shipping_address,
     order.shipping_cost, order.items_subtotal, order.tax_amount, order.total_price,
     order.stripe_payment_intent_id, order.stripe_checkout_session_id]
  );
  if (!row) return null;
  for (const l of lines) {
    await db.query(
      `INSERT INTO proshop_order_item (order_id, item_id, item_name, unit_price, quantity, subtotal) VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, l.item_id, l.item_name, l.unit_price, l.quantity, l.subtotal]
    );
  }
  return { ...row, items: lines };
}

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function sweepProperty(p) {
  // Lazy require: controllers/proshop pulls in a lot; keeps this module's
  // pure exports cheap to load in the check script.
  const { decrementStockForItems, emailOrderConfirmationInBackground, forFeed } = require('../controllers/proshop');
  const stripe = require('stripe')(p.stripe_secret_key);
  // The shop the site sells from: first active shop by name (GET /api/proshop/shops).
  const { rows: [shop] } = await pool.query(`SELECT id FROM shop WHERE status = 'active' AND property_id = $1 ORDER BY name LIMIT 1`, [p.id]);
  if (!shop) { console.warn(`Agentic orders ${p.name}: no active shop`); return 0; }
  const { rows: items } = await pool.query('SELECT id, name FROM proshop_item WHERE property_id = $1', [p.id]);
  const itemsByFeedId = new Map(items.map((i) => [feedId(i.id), i]));
  const { rows: seenRows } = await pool.query(
    `SELECT stripe_checkout_session_id FROM proshop_order
     WHERE property_id = $1 AND stripe_checkout_session_id IS NOT NULL AND created_at > now() - interval '3 days'`,
    [p.id]
  );
  const seen = new Set(seenRows.map((r) => r.stripe_checkout_session_id));

  let recorded = 0;
  // ponytail: a venue that also uses Checkout elsewhere gets those sessions
  // re-retrieved each sweep for 24 h; remember skipped ids if that grows.
  for await (const s of stripe.checkout.sessions.list({ status: 'complete', created: { gt: Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS }, limit: 100 })) {
    if (seen.has(s.id)) continue;
    try {
      const full = await stripe.checkout.sessions.retrieve(s.id, { expand: ['line_items.data.price'] }, { apiVersion: SESSION_API_VERSION });
      const mapped = sessionToOrder(full, itemsByFeedId);
      if (!mapped) continue;
      const order = await inTransaction((db) => recordOrder(db, p.id, shop.id, mapped));
      if (!order) continue;
      await decrementStockForItems(order.items);
      publishNewProshopOrder(p.id, forFeed(order)).catch((err) => console.error('Ably publish failed:', err.message));
      emailOrderConfirmationInBackground(order.id, p.id);
      recorded++;
    } catch (err) {
      console.error(`Agentic order ${s.id} for ${p.name} failed:`, err.message);
    }
  }
  return recorded;
}

async function sweepOrders() {
  for (const p of await enabledProperties()) {
    try {
      const n = await sweepProperty(p);
      if (n) console.log(`Agentic orders ${p.name}: recorded ${n}`);
    } catch (err) {
      console.error(`Agentic orders ${p.name} failed:`, err.message);
    }
  }
}

function startAgenticOrderJob() {
  const run = () => sweepOrders().catch((err) => console.error('Agentic order sweep failed:', err.message));
  run();
  const timer = setInterval(run, 5 * 60 * 1000);
  timer.unref();
}

module.exports = { sessionToOrder, recordOrder, sweepProperty, startAgenticOrderJob };
```

- [ ] **Step 6: Run the checks**

Run: `node -r dotenv/config scripts/check-agentic-commerce.js`
Expected: 17 × `ok`, then `all passed`. If the `shop` insert fails on a NOT NULL column, look at `CREATE TABLE IF NOT EXISTS shop` in `schema.sql` and add the missing column to the fixture only.

- [ ] **Step 7: Start the job and check nothing else broke.** In `src/server.js`, add `const { startAgenticOrderJob } = require('./lib/agenticOrders');` and call `startAgenticOrderJob();` after `startAgenticFeedJob();`. Then:
  - Run `node -r dotenv/config scripts/check-review-requests.js`. Expected: `all passed`.
  - Boot `PORT=3999 node -r dotenv/config src/server.js`. Create a website order through `POST /api/proshop/orders` with a local property's API key and a real `shop_id` and item. Expected: 201 with a `reference`, so the `allocateOrderReference` refactor holds. `GET /api/proshop/orders/:id` shows `"channel":"web"`.
  - Delete that test order (`DELETE FROM proshop_order WHERE id = …`; its items cascade) and stop the server.

- [ ] **Step 8: Commit**

```bash
git add src/lib/agenticOrders.js src/lib/orderReference.js src/controllers/proshop.js src/server.js scripts/check-agentic-commerce.js
git commit -m "Agentic commerce: sweep completed agent Checkout Sessions into paid proshop orders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sandbox end to end, then live rollout (each step needs the user's OK)

**Files:** none. Throwaway scripts go under `%TEMP%`.

- [ ] **Step 1: Point local WillyT at the sandbox.**
  - **Ask the user first.** This uses WillyT's stored **test** key from the live DB, and the user's Stripe sandbox must be onboarded for agentic commerce (spec, "The user's setup", steps 1–3).
  - Then make a temporary local property with that key, `currency USD`, the WillyT config with `enabled: true`, and a copy of WillyT's live `proshop_item` rows plus one active `shop`. Copy with a throwaway script that reads from `DATABASE_URL_LIVE` and writes only to `DATABASE_URL`.

- [ ] **Step 2: Upload once and watch the import.** Run `syncProperty(localProp)` from a throwaway script. Then poll `stripe.v2.commerce.productCatalog.imports.retrieve(id)` for each import ID until it reaches `succeeded`, `succeeded_with_errors` or `failed`.
  - On `succeeded_with_errors`, download `status_details.succeeded_with_errors.error_file.download_url.url` within 5 minutes, read `stripe_error_message`, fix the mapping in `agenticFeed.js` (with a new check for it), and repeat.
  - If `create` itself fails over the API version, pass the request option `{ apiVersion: '2026-09-30.preview' }` as the second argument of `create` and note it in the spec.
  - Expected: product, pricing and inventory all reach `succeeded`, with 26 products.

- [ ] **Step 3: Test purchase.** Ask the user to open Stripe Dashboard (sandbox), go to Agentic commerce → View feed → Test on a product, and complete a purchase **with their own email address**.

- [ ] **Step 4: Sweep and check.** Run `sweepProperty(localProp)` once. Expected:
  - it returns `1`;
  - the order shows `channel: 'agent'`, a reference, the shipping address and Stripe's total;
  - tracked stock goes down;
  - the confirmation email arrives in the user's inbox.

  If `price.external_reference` comes back empty, log the retrieved session's line items, find where the feed `id` actually appears (e.g. `price.product.metadata`), and adjust `sessionToOrder` with a new check. Then delete the temporary local property's rows.

- [ ] **Step 5: Live rollout, asking before each step:**
  1. Run `node scripts/run-migration.js src/db/migrate-2026-10-09-agentic-commerce.sql` (local is already done and the migration is idempotent). This must happen before the push, because both jobs query the new columns at boot.
  2. `git push`, then wait for Render. `GET /api/property/agentic-commerce` without a key should answer 401.
  3. Turn on WillyT with `set_agentic_commerce` (staff admin session): `{ enabled: true, sanity_project_id: 'a26xzsqt', sanity_dataset: 'production', site_url: 'https://willy-t-bvi.vercel.app', brand: 'Willy T' }`. The next feed run uploads to whatever account WillyT's stored key is: test mode today.
  4. The user requests agent connections in the Stripe dashboard (spec, setup step 5).
