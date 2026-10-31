const pool = require('../db');
const apiKeys = require('../lib/apiKeys');
const { unknownPermissions } = require('../lib/permissions');
const { isValidUuid } = require('../middleware/validate');

// API key management, admin only, for both owners: the property
// (/api/property/api-keys, owner { property_id }) and the org
// (/api/organization/api-keys, owner { clerk_org_id }). The legacy single-key
// endpoints (/api-key, /rotate, /disable, /enable) act on the row named
// 'Default' with their old response shapes, so the dashboard is untouched.
// See docs/superpowers/specs/2026-10-31-permissions-design.md.

// 'Default' is reserved so "the row named Default" is always one row.
const RESERVED = 'Default';

// { error } or the validated fields present in body. `permissions` may be
// null (full key) or a list of known names; `enabled` a boolean.
function parseBody(body, { requireName }) {
  const out = {};
  if (body.name !== undefined || requireName) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) return { error: 'name must be 1-100 characters' };
    if (body.name.trim() === RESERVED) return { error: `'${RESERVED}' is reserved for the property's main key` };
    out.name = body.name.trim();
  }
  if (body.permissions !== undefined) {
    if (body.permissions === null) out.permissions = null;
    else {
      const unknown = unknownPermissions(body.permissions);
      if (unknown === null) return { error: 'permissions must be null (full key) or an array of permission names' };
      if (unknown.length) return { error: `Unknown permissions: ${unknown.join(', ')}` };
      out.permissions = body.permissions;
    }
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    out.enabled = body.enabled;
  }
  return out;
}

const legacyShape = (row) => ({ api_key: row.key, api_key_enabled: row.enabled });

function forOwner(ownerOf) {
  const wrap = (fn) => async (req, res, next) => {
    try { await fn(req, res, ownerOf(req)); } catch (err) { next(err); }
  };
  const setDefault = (patch) => async (req, res, owner) => {
    const d = await apiKeys.ensureDefault(pool, owner);
    res.json(legacyShape(await apiKeys.update(pool, owner, d.id, typeof patch === 'function' ? patch(owner) : patch)));
  };
  return {
    getLegacy: wrap(async (req, res, owner) => res.json(legacyShape(await apiKeys.ensureDefault(pool, owner)))),
    rotateLegacy: wrap(async (req, res, owner) => {
      const d = await apiKeys.ensureDefault(pool, owner);
      const row = await apiKeys.update(pool, owner, d.id, { key: apiKeys.generateKey(owner) });
      res.json({ api_key: row.key });
    }),
    disableLegacy: wrap(setDefault({ enabled: false })),
    enableLegacy: wrap(setDefault({ enabled: true })),

    list: wrap(async (req, res, owner) => res.json(await apiKeys.list(pool, owner))),
    create: wrap(async (req, res, owner) => {
      const v = parseBody(req.body, { requireName: true });
      if (v.error) return res.status(400).json({ error: v.error });
      res.status(201).json(await apiKeys.create(pool, owner, { ...v, created_by: req.user.id }));
    }),
    update: wrap(async (req, res, owner) => {
      if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'API key not found' });
      const v = parseBody(req.body, { requireName: false });
      if (v.error) return res.status(400).json({ error: v.error });
      const row = await apiKeys.update(pool, owner, req.params.id, v);
      if (!row) return res.status(404).json({ error: 'API key not found' });
      res.json(row);
    }),
    remove: wrap(async (req, res, owner) => {
      if (!isValidUuid(req.params.id) || !(await apiKeys.remove(pool, owner, req.params.id))) {
        return res.status(404).json({ error: 'API key not found' });
      }
      res.status(204).end();
    }),
  };
}

module.exports = {
  property: forOwner((req) => ({ property_id: req.property_id })),
  organization: forOwner((req) => ({ clerk_org_id: req.clerk_org_id })),
};
