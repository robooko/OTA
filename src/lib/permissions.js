const pool = require('../db');

// The permission vocabulary. One name per gated action; a route asks for one
// with requirePermission(name) (middleware/auth.js). Admins and full API keys
// pass every check; staff pass when their grant at the property lists the
// name; a scoped key passes when its list does. See
// docs/superpowers/specs/2026-10-31-permissions-design.md.
const PERMISSIONS = [
  'housekeeping.inspect', // record an inspection (pass / fail a clean)
  'housekeeping.manage',  // checklist items, stayover rule, minibar catalogue and lists
];

// null when `list` isn't an array of strings; otherwise the names not in
// PERMISSIONS (empty = all valid).
function unknownPermissions(list) {
  if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) return null;
  return list.filter((p) => !PERMISSIONS.includes(p));
}

async function getGrant(db = pool, propertyId, clerkUserId) {
  const { rows } = await db.query(
    'SELECT permissions FROM staff_permission WHERE property_id = $1 AND clerk_user_id = $2',
    [propertyId, clerkUserId]
  );
  return rows[0]?.permissions ?? [];
}

async function setGrant(db = pool, propertyId, clerkUserId, permissions, updatedBy) {
  const { rows } = await db.query(
    `INSERT INTO staff_permission (property_id, clerk_user_id, permissions, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (property_id, clerk_user_id)
     DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING *`,
    [propertyId, clerkUserId, permissions, updatedBy]
  );
  return rows[0];
}

module.exports = { PERMISSIONS, unknownPermissions, getGrant, setGrant };
