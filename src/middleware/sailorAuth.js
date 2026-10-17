const { createClerkClient, verifyToken } = require('@clerk/backend');
const { normalEmail } = require('../lib/sailorDocuments');

// Sailor identity for shared documents: an X-Sailor-Token header carrying a
// Clerk session token from sidon-ai or a booking site. Trusted instances are
// SAILOR_CLERK_SECRET_KEYS (comma list), separate from the staff instance.
// The key is the user's PRIMARY email, and only once Clerk has verified it.

// Seam so checks can stub Clerk.
const clerkClients = new Map();
module.exports._clerk = {
  verifyToken: (token, secretKey) => verifyToken(token, { secretKey }),
  getUser: (secretKey, sub) => {
    if (!clerkClients.has(secretKey)) clerkClients.set(secretKey, createClerkClient({ secretKey }));
    return clerkClients.get(secretKey).users.getUser(sub);
  },
};

// -> { email } or null. Never throws.
module.exports.resolveSailor = async (token) => {
  const keys = String(process.env.SAILOR_CLERK_SECRET_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  for (const key of keys) {
    let claims;
    try { claims = await module.exports._clerk.verifyToken(token, key); } catch { continue; }
    try {
      const user = await module.exports._clerk.getUser(key, claims.sub);
      const primary = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
      return primary?.verification?.status === 'verified' ? { email: normalEmail(primary.emailAddress) } : null;
    } catch (err) {
      console.error('Sailor lookup failed:', err.message);
      return null;
    }
  }
  return null;
};

const SIGN_IN = { error: 'Sign in required' };

async function sailorFromHeader(req, res, next, optional) {
  try {
    const token = req.get('X-Sailor-Token');
    if (!token && optional) return next();
    const sailor = token ? await module.exports.resolveSailor(token) : null;
    if (!sailor) return res.status(401).json(SIGN_IN);
    req.sailor = sailor;
    next();
  } catch (err) { next(err); }
}

module.exports.authenticateSailor = (req, res, next) => sailorFromHeader(req, res, next, false);
// No header -> carry on without req.sailor; a bad token is still a 401.
module.exports.optionalSailor = (req, res, next) => sailorFromHeader(req, res, next, true);
