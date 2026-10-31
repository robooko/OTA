const pool = require('../db');
const { getGrant } = require('../lib/permissions');

// permissions: the caller's grant at this property. Empty for admins, who
// pass every check, and for staff with no grant.
async function me(req, res, next) {
  try {
    const permissions = req.user.role === 'admin' ? [] : await getGrant(pool, req.property_id, req.user.id);
    res.json({ property_id: req.property_id, role: req.user.role, permissions });
  } catch (err) { next(err); }
}

module.exports = { me };
