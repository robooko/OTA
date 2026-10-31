const crypto = require('crypto');
const pool = require('../db');

// api_key rows: several named keys per property ({ property_id }) or org
// ({ clerk_org_id }). permissions NULL = full key (does everything, as every
// key did before 2026-10-31); a list = scoped to those names. The legacy
// property.api_key / organization.api_key columns are no longer read or
// written -- see migrate-2026-10-31-permissions.sql.

const COLS = 'id, property_id, clerk_org_id, name, key, permissions, enabled, created_at, created_by';

function ownerCol(owner) {
  if (owner?.property_id) return ['property_id', owner.property_id];
  if (owner?.clerk_org_id) return ['clerk_org_id', owner.clerk_org_id];
  throw new Error('owner must be { property_id } or { clerk_org_id }');
}

function generateKey(owner) {
  const [col] = ownerCol(owner);
  return (col === 'property_id' ? 'prop_' : 'org_') + crypto.randomBytes(32).toString('hex');
}

async function create(db = pool, owner, { name = 'Default', permissions = null, enabled = true, created_by = null, key } = {}) {
  const [col, id] = ownerCol(owner);
  // The organization row exists only to be a key's parent; make it on demand
  // so no caller depends on call order (the old ensureOrg did the same).
  if (col === 'clerk_org_id') {
    await db.query('INSERT INTO organization (clerk_org_id) VALUES ($1) ON CONFLICT (clerk_org_id) DO NOTHING', [id]);
  }
  const { rows } = await db.query(
    `INSERT INTO api_key (${col}, name, key, permissions, enabled, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLS}`,
    [id, name, key ?? generateKey(owner), permissions, enabled, created_by]
  );
  return rows[0];
}

// Enabled rows only: a disabled key is "no such key" to the auth rail.
async function findByKey(db = pool, key) {
  const { rows } = await db.query(`SELECT ${COLS} FROM api_key WHERE key = $1 AND enabled = true`, [key]);
  return rows[0] ?? null;
}

// The row the legacy single-key endpoints act on, or null. One per owner
// (partial unique indexes api_key_default_*_key).
async function findDefault(db = pool, owner) {
  const [col, id] = ownerCol(owner);
  const { rows } = await db.query(`SELECT ${COLS} FROM api_key WHERE ${col} = $1 AND name = 'Default'`, [id]);
  return rows[0] ?? null;
}

// findDefault, creating the row full and enabled if missing. Two concurrent
// first calls race to the unique index; the loser re-reads the winner's row.
async function ensureDefault(db = pool, owner, created_by = null) {
  const found = await findDefault(db, owner);
  if (found) return found;
  try {
    return await create(db, owner, { created_by });
  } catch (err) {
    if (err.code !== '23505') throw err;
    return findDefault(db, owner);
  }
}

async function list(db = pool, owner) {
  const [col, id] = ownerCol(owner);
  const { rows } = await db.query(`SELECT ${COLS} FROM api_key WHERE ${col} = $1 ORDER BY created_at, id`, [id]);
  return rows;
}

// Only the fields present in `patch` change; permissions: null makes the key
// full again. null when no row with that id belongs to the owner.
async function update(db = pool, owner, keyId, patch) {
  const [col, id] = ownerCol(owner);
  const fields = ['name', 'permissions', 'enabled', 'key'].filter((f) => patch[f] !== undefined);
  if (!fields.length) {
    const { rows } = await db.query(`SELECT ${COLS} FROM api_key WHERE id = $1 AND ${col} = $2`, [keyId, id]);
    return rows[0] ?? null;
  }
  const set = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
  const { rows } = await db.query(
    `UPDATE api_key SET ${set} WHERE id = $1 AND ${col} = $2 RETURNING ${COLS}`,
    [keyId, id, ...fields.map((f) => patch[f])]
  );
  return rows[0] ?? null;
}

async function remove(db = pool, owner, keyId) {
  const [col, id] = ownerCol(owner);
  const { rowCount } = await db.query(`DELETE FROM api_key WHERE id = $1 AND ${col} = $2`, [keyId, id]);
  return rowCount > 0;
}

module.exports = { generateKey, create, findByKey, findDefault, ensureDefault, list, update, remove };
