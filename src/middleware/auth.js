const { createClerkClient, verifyToken } = require('@clerk/backend');
const { isMachineToken, verifyMachineAuthToken } = require('@clerk/backend/internal');
const pool = require('../db');
const { apiKeyRateLimiter } = require('./rateLimiter');
const { grantStarter } = require('../lib/tokens');
const { resolveStaffProperty, resolveSiteProperty, siteSelectors } = require('../lib/propertyResolver');
const { findByKey } = require('../lib/apiKeys');
const { PERMISSIONS, getGrant } = require('../lib/permissions');

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error('CLERK_SECRET_KEY is required');
}

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const BAD_KEY = 'Missing or invalid Authorization header or X-Api-Key';
const SCOPED_KEY = 'This key is scoped; this route needs a full key or a named permission';

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

  if (isMachineToken(token)) return authenticateOAuth(token, req, res, next);

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

// A Clerk OAuth access token (an MCP client such as a claude.ai connector,
// signed in through Clerk -- see routes/mcp.js). It names a user but no
// active org: the org is the one owning X-Property-Id (MCP's property_id),
// else the user's only one. In several orgs with no hotel named, only
// list_properties works (across all of them, as staff) -- authenticate()
// asks for a property_id.
// ponytail: 2 Clerk API calls per request (and MCP loops back once per tool
// call); cache by token if Clerk rate limits bite.
async function authenticateOAuth(token, req, res, next) {
  try {
    const r = await verifyMachineAuthToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    if (r.errors || r.tokenType !== 'oauth_token') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const userId = r.data.subject;
    const { data: memberships } = await clerkClient.users.getOrganizationMembershipList({ userId, limit: 100 });
    const orgs = memberships.map((m) => ({ id: m.organization.id, role: mapClerkRole(m.role.replace(/^org:/, '')) }));
    if (!orgs.length) return res.status(401).json({ error: 'This account is not in any organization' });

    let org = orgs.length === 1 ? orgs[0] : null;
    const wanted = req.headers['x-property-id'];
    if (wanted) {
      const { rows } = await pool.query('SELECT clerk_org_id FROM property WHERE id::text = $1', [wanted]);
      org = orgs.find((o) => o.id === rows[0]?.clerk_org_id) ?? org;
    }
    req.auth_method = 'bearer';
    if (org) {
      req.clerk_org_id = org.id;
      req.user = { id: userId, role: org.role };
    } else {
      req.clerk_org_ids = orgs.map((o) => o.id);
      req.user = { id: userId, role: 'staff' };
    }
    next();
  } catch (err) {
    next(err);
  }
}

// authenticateOrg + the hotel: X-Property-Id when the org has several,
// implied when it has one, auto-created (under a lock) when it has none.
function authenticate(req, res, next) {
  authenticateOrg(req, res, async () => {
    try {
      const orgId = req.clerk_org_id;
      if (!orgId) return res.status(400).json({ error: 'This account is in several organizations: pass a property_id (see list_properties)' });
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
      req.api_key = r.apiKey; // { id, permissions }; permissions null = full key
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
      const row = await findByKey(pool, key);
      if (!row) return res.status(401).json({ error: BAD_KEY });
      if (row.property_id) return res.status(403).json({ error: 'This endpoint requires an organization API key' });
      req.clerk_org_id = row.clerk_org_id;
      req.api_key = { id: row.id, permissions: row.permissions };
      req.auth_method = 'api_key';
      next();
    } catch (err) {
      next(err);
    }
  });
}

// Org-level, no property: a Clerk bearer (authenticateOrg) or an org API key
// (authenticateOrgKey). /api/organization/properties, so an agent holding the
// org key can list and create the org's hotels.
function authenticateOrgOrKey(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return authenticateOrg(req, res, next);
  return authenticateOrgKey(req, res, next);
}

// Credentials only, no hotel: a valid Clerk bearer or any enabled API key.
// /api/mcp, where each tool call picks its hotel (property_id) and the API
// it loops back to resolves and authorises it.
function authenticateCaller(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return authenticateOrg(req, res, next);
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: BAD_KEY });
  return apiKeyRateLimiter(req, res, async () => {
    try {
      if (!(await findByKey(pool, key))) return res.status(401).json({ error: BAD_KEY });
      next();
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

// Same role gate, but a full api-key caller passes it: the key is already
// property-scoped and every other property-wide write it can reach (PUT
// /api/property/me -- currency, timezone, tax, enabled_modules) trusts it
// the same way. A scoped key (one given a permissions list) fails: these
// routes have no permission name yet, so there is nothing it could list.
// Use this instead of requireRole on a route that has been widened to
// authenticateOrApiKey, so staff sessions keep the role rule they had
// rather than silently losing it.
function requireRoleOrApiKey(...roles) {
  const guard = requireRole(...roles);
  return (req, res, next) => {
    if (req.auth_method === 'api_key') {
      return req.api_key.permissions === null ? next() : res.status(403).json({ error: SCOPED_KEY });
    }
    return guard(req, res, next);
  };
}

// Who passes a named permission (src/lib/permissions.js): admins; a full
// api key; a scoped key listing the name; staff whose grant at the resolved
// property lists it. Grants are per property, so on an org-level route
// (no req.property_id) only admins and full keys pass.
async function hasPermission(req, name) {
  if (req.auth_method === 'api_key') return req.api_key.permissions === null || req.api_key.permissions.includes(name);
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  if (!req.property_id) return false;
  return (await getGrant(pool, req.property_id, req.user.id)).includes(name);
}

function requirePermission(name) {
  if (!PERMISSIONS.includes(name)) throw new Error(`Unknown permission: ${name}`);
  return async (req, res, next) => {
    try {
      if (await hasPermission(req, name)) return next();
      res.status(403).json({ error: 'Missing permission', permission: name });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { clerkClient, authenticate, authenticateOrg, authenticateOrApiKey, authenticateOrgKey, authenticateOrgOrKey, authenticateCaller, requireRole, requireRoleOrApiKey, hasPermission, requirePermission };
