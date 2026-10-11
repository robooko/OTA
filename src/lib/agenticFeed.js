// Stripe agentic commerce catalog feed -- see
// docs/superpowers/specs/2026-10-09-agentic-commerce-proshop-design.md.
// One row per active proshop_item, joined by name to the venue site's
// public Sanity `product` docs (copy, image, page). OTA stores none of that
// content; the site doesn't change.

const pool = require('../db');

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

module.exports = {
  PRODUCT_COLUMNS, INVENTORY_COLUMNS, PRICING_COLUMNS,
  feedId, matchDocs, shippingEntries, buildFeeds, toCsv,
  enabledProperties, uploadFeed, syncProperty, startAgenticFeedJob,
};
