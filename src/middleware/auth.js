const { createClerkClient, verifyToken } = require('@clerk/backend');
const pool = require('../db');
const { apiKeyRateLimiter } = require('./rateLimiter');
const { grantStarter } = require('../lib/tokens');
const { resolveStaffProperty, resolveSiteProperty, siteSelectors } = require('../lib/propertyResolver');

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY is required');
}

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const BAD_KEY = 'Missing or invalid Authorization header or X-Api-Key';

function mapClerkRole(orgRole) {
  return orgRole === 'admin' ? 'admin' : 'staff';
}

// Clerk bearer -> org + user, no property. For routes that span the org's
// hotels (listing/creating them, the org API key).
async function authenticateOrg(req, res, next) {
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

  req.clerk_org_id = orgId;
  req.user = { id: claims.sub, role: mapClerkRole(claims.o.rol) };
  req.auth_method = 'bearer'; // staff rail -- bypasses session join codes
  next();
}

// authenticateOrg + the hotel: X-Property-Id when the org has several,
// implied when it has one, auto-created (under a lock) when it has none.
function authenticate(req, res, next) {
  authenticateOrg(req, res, async () => {
    try {
      const orgId = req.clerk_org_id;
      const r = await resolveStaffProperty(pool, orgId, req.headers['x-property-id'], async () =>
        (await clerkClient.organizations.getOrganization({ organizationId: orgId })).name);
      // Free starter tokens so the metered features work before anyone is
      // asked for a card -- before the error check, since a brand-new org's
      // first request can create its hotel and still 404 on a stale
      // X-Property-Id. Not fatal: a failed grant just means zero balance.
      if (r.createdId) {
        await grantStarter(r.createdId).catch((err) => console.error(`Starter token grant failed for property ${r.createdId}:`, err.message));
      }
      if (r.error) return res.status(r.status).json({ error: r.error });
      req.property_id = r.propertyId;
      next();
    } catch (err) {
      next(err);
    }
  });
}

// Bearer -> authenticate. X-Api-Key -> a per-property key's own hotel, or an
// org key + X-Property-Id / X-Property-Slug / X-Site-Host (see
// lib/propertyResolver.js).
async function authenticateOrApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return authenticate(req, res, next);
  }

  if (!req.headers['x-api-key']) {
    return res.status(401).json({ error: BAD_KEY });
  }

  return apiKeyRateLimiter(req, res, async () => {
    try {
      const r = await resolveSiteProperty(pool, siteSelectors(req));
      if (!r) return res.status(401).json({ error: BAD_KEY });
      if (r.error) return res.status(r.status).json({ error: r.error });
      req.property_id = r.propertyId;
      if (r.clerkOrgId) req.clerk_org_id = r.clerkOrgId;
      req.auth_method = 'api_key'; // untrusted guest-proxy rail -- join codes enforced
      next();
    } catch (err) {
      next(err);
    }
  });
}

// Org API key only, no property: /api/site/* (the group website's hotel
// list). A per-property key is told why it isn't enough.
async function authenticateOrgKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: BAD_KEY });

  return apiKeyRateLimiter(req, res, async () => {
    try {
      const org = await pool.query('SELECT clerk_org_id FROM organization WHERE api_key = $1 AND api_key_enabled = true', [key]);
      if (org.rows.length) {
        req.clerk_org_id = org.rows[0].clerk_org_id;
        req.auth_method = 'api_key';
        return next();
      }
      const prop = await pool.query('SELECT 1 FROM property WHERE api_key = $1 AND api_key_enabled = true', [key]);
      if (prop.rows.length) return res.status(403).json({ error: 'This endpoint requires an organization API key' });
      return res.status(401).json({ error: BAD_KEY });
    } catch (err) {
      next(err);
    }
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Same role gate, but an api-key caller passes it: the key is already
// property-scoped and every other property-wide write it can reach (PUT
// /api/property/me -- currency, timezone, tax, enabled_modules) trusts it
// the same way. Use this instead of requireRole on a route that has been
// widened to authenticateOrApiKey, so staff sessions keep the role rule
// they had rather than silently losing it.
function requireRoleOrApiKey(...roles) {
  const guard = requireRole(...roles);
  return (req, res, next) => {
    if (req.auth_method === 'api_key') return next();
    return guard(req, res, next);
  };
}

module.exports = { authenticate, authenticateOrg, authenticateOrApiKey, authenticateOrgKey, requireRole, requireRoleOrApiKey };
