const { createClerkClient, verifyToken } = require('@clerk/backend');
const pool = require('../db');

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY is required');
}

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function mapClerkRole(orgRole) {
  return orgRole === 'admin' ? 'admin' : 'staff';
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);

  let claims;
  try {
    claims = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
  } catch (err) {
    console.error('Clerk token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Clerk's v2 session tokens nest active-organization info under a short
  // `o` claim ({ id, rol, slg }), not flat org_id/org_role claims -- this
  // is confirmed against this project's real Clerk instance, not assumed.
  const orgId = claims.o?.id;
  if (!orgId) {
    return res.status(401).json({ error: 'An organization context is required' });
  }

  try {
    const propertyRes = await pool.query('SELECT id FROM property WHERE clerk_org_id = $1', [orgId]);
    let propertyId;
    if (propertyRes.rows.length) {
      propertyId = propertyRes.rows[0].id;
    } else {
      const org = await clerkClient.organizations.getOrganization({ organizationId: orgId });
      const { rows } = await pool.query(
        'INSERT INTO property (name, clerk_org_id) VALUES ($1, $2) RETURNING id',
        [org.name.slice(0, 100), orgId]
      );
      propertyId = rows[0].id;
    }

    req.property_id = propertyId;
    req.user = { id: claims.sub, role: mapClerkRole(claims.o.rol) };
    next();
  } catch (err) {
    next(err);
  }
}

async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  const key = req.headers['x-api-key'];
  if (!key) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
  }

  try {
    const { rows } = await pool.query('SELECT id FROM property WHERE api_key = $1', [key]);
    if (!rows.length) return res.status(401).json({ error: 'Missing or invalid Authorization header or X-Api-Key' });
    req.property_id = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authenticateOrApiKey, requireRole };
