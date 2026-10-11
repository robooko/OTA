const pool = require('../db');

// Turns the hotel selectors a caller sends into one property_id. Staff
// (Clerk org) and website keys (per-property or org-level) both land here --
// see docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.
// Every function takes `db` (default pool) so
// scripts/check-multi-property.js can run it inside a rolled-back transaction.

const PROPERTY_NOT_FOUND = 'Property not found';
const STAFF_AMBIGUOUS = 'X-Property-Id is required: this organization has multiple properties';
const SITE_AMBIGUOUS = 'X-Property-Id, X-Property-Slug or X-Site-Host is required: this organization has multiple properties';
const HOST_AMBIGUOUS = 'X-Property-Slug is required: this host serves multiple properties';
const NO_ACTIVE = 'This organization has no active properties';

const notFound = () => ({ status: 404, error: PROPERTY_NOT_FOUND });

// Bare host ("Seaview-Hotel.com:443") or full URL -> "seaview-hotel.com".
// URL does lowercasing, punycode, and drops port/userinfo/path/query. The
// only host normaliser -- property_website.url and X-Site-Host both go
// through it, so the two sides can't drift.
function hostKey(input) {
  if (!input) return null;
  try {
    const s = String(input).trim();
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).hostname;
    return host.replace(/\.$/, '').replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

// Absent and '' both mean "not sent" -- a website forwarding an unset env
// var shouldn't turn into a 404.
const given = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));

function siteSelectors(req) {
  return {
    key: req.headers['x-api-key'],
    propertyId: req.headers['x-property-id'],
    slug: req.headers['x-property-slug'],
    host: req.headers['x-site-host'],
  };
}

// X-Api-Key -> property. A per-property key is its hotel, full stop (routing
// headers ignored). An org key picks among the org's active hotels:
// X-Property-Id > X-Property-Slug > X-Site-Host > "the only one". null means
// the key matched nothing (caller's 401).
async function resolveSiteProperty(db = pool, sel = {}) {
  const key = given(sel.key);
  const propertyId = given(sel.propertyId);
  const slug = given(sel.slug);
  const host = given(sel.host);
  if (!key) return null;

  const own = await db.query('SELECT id FROM property WHERE api_key = $1 AND api_key_enabled = true', [key]);
  if (own.rows.length) return { propertyId: own.rows[0].id };

  const org = await db.query('SELECT clerk_org_id FROM organization WHERE api_key = $1 AND api_key_enabled = true', [key]);
  if (!org.rows.length) return null;
  const clerkOrgId = org.rows[0].clerk_org_id;

  const { rows: props } = await db.query(
    "SELECT id, slug FROM property WHERE clerk_org_id = $1 AND status = 'active'",
    [clerkOrgId]
  );
  const pick = (id) => (id ? { propertyId: id, clerkOrgId } : notFound());

  if (propertyId) return pick(props.find((p) => p.id === propertyId.toLowerCase())?.id);
  if (slug) return pick(props.find((p) => p.slug === slug)?.id);
  if (host) {
    const want = hostKey(host);
    if (!want || !props.length) return notFound();
    const { rows: sites } = await db.query(
      "SELECT property_id, url FROM property_website WHERE property_id = ANY($1::uuid[]) AND status = 'active'",
      [props.map((p) => p.id)]
    );
    const ids = [...new Set(sites.filter((s) => hostKey(s.url) === want).map((s) => s.property_id))];
    // A group domain (mygroup.com/seaview, /harbour) legitimately serves
    // several hotels; the slug picks between them.
    if (ids.length > 1) return { status: 400, error: HOST_AMBIGUOUS };
    return pick(ids[0]);
  }
  if (props.length === 1) return pick(props[0].id);
  return props.length ? { status: 400, error: SITE_AMBIGUOUS } : notFound();
}

// Clerk org -> property. X-Property-Id when the org has several hotels,
// implied when it has one. An org with no property rows at all gets one
// auto-created under an advisory lock: since property.clerk_org_id stopped
// being UNIQUE, nothing else stops two concurrent first requests creating
// two hotels (and a permanent 400). An org whose rows are all inactive gets
// a 403, never a fresh hotel. `createdId` rides on the result -- errors
// included -- only when this call inserted the hotel, so the caller can
// grant starter tokens exactly once (outside any transaction this may run in).
async function resolveStaffProperty(db = pool, orgId, requestedId, fetchOrgName) {
  const select = (q) => q.query('SELECT id, status FROM property WHERE clerk_org_id = $1', [orgId]);
  let { rows } = await select(db);
  let made = {};

  if (!rows.length) {
    const name = String(await fetchOrgName()).slice(0, 100); // network call stays outside the lock
    // On the pool, take a dedicated client for our own transaction. Handed a
    // client (the check script's), it's already in one -- just lock in it.
    const owns = db === pool;
    const client = owns ? await pool.connect() : db;
    try {
      if (owns) await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('property-autocreate:' || $1))", [orgId]);
      ({ rows } = await select(client));
      if (!rows.length) {
        ({ rows } = await client.query(
          'INSERT INTO property (name, clerk_org_id) VALUES ($1, $2) RETURNING id, status',
          [name, orgId]
        ));
        made = { createdId: rows[0].id };
      }
      if (owns) await client.query('COMMIT');
    } catch (err) {
      if (owns) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (owns) client.release();
    }
  }

  const active = rows.filter((r) => r.status === 'active');
  if (!active.length) return { status: 403, error: NO_ACTIVE, ...made };
  const wanted = given(requestedId);
  if (wanted) {
    const id = wanted.toLowerCase();
    return active.some((r) => r.id === id) ? { propertyId: id, ...made } : { ...notFound(), ...made };
  }
  if (active.length === 1) return { propertyId: active[0].id, ...made };
  return { status: 400, error: STAFF_AMBIGUOUS, ...made };
}

module.exports = {
  PROPERTY_NOT_FOUND, STAFF_AMBIGUOUS, SITE_AMBIGUOUS, HOST_AMBIGUOUS, NO_ACTIVE,
  hostKey, siteSelectors, resolveSiteProperty, resolveStaffProperty,
};
