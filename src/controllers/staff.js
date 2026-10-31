const pool = require('../db');
const { clerkClient } = require('../middleware/auth');
const { unknownPermissions, setGrant } = require('../lib/permissions');

// Staff grants at the current property, admin only. Members come from Clerk
// (the org's membership list), grants from staff_permission; admins need no
// grant and pass every check. See
// docs/superpowers/specs/2026-10-31-permissions-design.md.

// Clerk's membership list reports 'org:admin' / 'org:member'; session tokens
// carry 'admin' / 'member' under o.rol (mapClerkRole). Same two buckets.
const roleOf = (clerkRole) => (clerkRole === 'org:admin' || clerkRole === 'admin' ? 'admin' : 'staff');

async function allMembers(organizationId) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const page = await clerkClient.organizations.getOrganizationMembershipList({ organizationId, limit: 500, offset });
    out.push(...page.data);
    if (out.length >= page.totalCount || page.data.length === 0) return out;
  }
}

async function listStaff(req, res, next) {
  try {
    const members = await allMembers(req.clerk_org_id);
    const { rows } = await pool.query('SELECT clerk_user_id, permissions FROM staff_permission WHERE property_id = $1', [req.property_id]);
    const grants = new Map(rows.map((r) => [r.clerk_user_id, r.permissions]));
    res.json(members.map((m) => ({
      clerk_user_id: m.publicUserData?.userId,
      first_name: m.publicUserData?.firstName ?? null,
      last_name: m.publicUserData?.lastName ?? null,
      email: m.publicUserData?.identifier ?? null,
      role: roleOf(m.role),
      permissions: grants.get(m.publicUserData?.userId) ?? [],
    })));
  } catch (err) {
    next(err);
  }
}

async function setStaffPermissions(req, res, next) {
  try {
    const unknown = unknownPermissions(req.body.permissions);
    if (unknown === null) return res.status(400).json({ error: 'permissions must be an array of permission names' });
    if (unknown.length) return res.status(400).json({ error: `Unknown permissions: ${unknown.join(', ')}` });
    const { clerk_user_id } = req.params;
    const member = await clerkClient.organizations.getOrganizationMembershipList({ organizationId: req.clerk_org_id, userId: [clerk_user_id], limit: 1 });
    if (!member.data.length) return res.status(404).json({ error: 'User is not a member of this organization' });
    const row = await setGrant(pool, req.property_id, clerk_user_id, req.body.permissions, req.user.id);
    res.json(row);
  } catch (err) {
    next(err);
  }
}

module.exports = { listStaff, setStaffPermissions };
