const crypto = require('crypto');
const pool = require('../db');
const { grantStarter } = require('../lib/tokens');
const { isValidSlug, SLUG_TAKEN, isSlugConflict } = require('../middleware/validate');

// Org-level routes: req.clerk_org_id comes from authenticateOrg (staff) or
// authenticateOrgKey (website) -- no req.property_id here. See
// docs/superpowers/specs/2026-10-11-multi-property-per-org-design.md.

function generateOrgApiKey() {
  return 'org_' + crypto.randomBytes(32).toString('hex');
}

async function listProperties(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, slug, status FROM property WHERE clerk_org_id = $1 ORDER BY name',
      [req.clerk_org_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createProperty(req, res, next) {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'name is required (at most 100 characters)' });
    const slug = req.body.slug ?? null;
    if (slug !== null && !isValidSlug(slug)) {
      return res.status(400).json({ error: 'slug must be 1-60 lowercase letters, digits or hyphens, or null' });
    }
    const { rows } = await pool.query(
      `INSERT INTO property (name, clerk_org_id, slug) VALUES ($1, $2, $3)
       RETURNING id, name, slug, status, currency, timezone`,
      [name, req.clerk_org_id, slug]
    );
    // Same starter grant a first-login hotel gets. Not fatal.
    await grantStarter(rows[0].id).catch((err) => console.error(`Starter token grant failed for property ${rows[0].id}:`, err.message));
    res.status(201).json(rows[0]);
  } catch (err) {
    if (isSlugConflict(err)) return res.status(409).json({ error: SLUG_TAKEN });
    next(err);
  }
}

// The organization row exists only for its key; every key route creates it
// on demand so none depends on call order.
async function ensureOrg(orgId) {
  await pool.query(
    'INSERT INTO organization (clerk_org_id, api_key) VALUES ($1, $2) ON CONFLICT (clerk_org_id) DO NOTHING',
    [orgId, generateOrgApiKey()]
  );
}

async function getApiKey(req, res, next) {
  try {
    await ensureOrg(req.clerk_org_id);
    const { rows } = await pool.query('SELECT api_key, api_key_enabled FROM organization WHERE clerk_org_id = $1', [req.clerk_org_id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function rotateApiKey(req, res, next) {
  try {
    await ensureOrg(req.clerk_org_id);
    const { rows } = await pool.query(
      'UPDATE organization SET api_key = $1 WHERE clerk_org_id = $2 RETURNING api_key',
      [generateOrgApiKey(), req.clerk_org_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function setApiKeyEnabled(req, res, next, enabled) {
  try {
    await ensureOrg(req.clerk_org_id);
    const { rows } = await pool.query(
      'UPDATE organization SET api_key_enabled = $1 WHERE clerk_org_id = $2 RETURNING api_key, api_key_enabled',
      [enabled, req.clerk_org_id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}
const disableApiKey = (req, res, next) => setApiKeyEnabled(req, res, next, false);
const enableApiKey = (req, res, next) => setApiKeyEnabled(req, res, next, true);

// The group website's hotel list. Public-safe fields only -- no keys,
// Stripe, Vercel or Sidon columns.
async function listSiteProperties(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.slug, p.currency, p.timezone,
              COALESCE(array_agg(w.url ORDER BY w.created_at) FILTER (WHERE w.id IS NOT NULL), '{}') AS websites
       FROM property p
       LEFT JOIN property_website w ON w.property_id = p.id AND w.status = 'active'
       WHERE p.clerk_org_id = $1 AND p.status = 'active'
       GROUP BY p.id
       ORDER BY p.name`,
      [req.clerk_org_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { listProperties, createProperty, getApiKey, rotateApiKey, disableApiKey, enableApiKey, listSiteProperties };
