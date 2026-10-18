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

// The Clerk user's primary email, only once verified; else null.
module.exports.verifiedPrimaryEmail = (user) => {
  const primary = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId);
  return primary?.verification?.status === 'verified' ? normalEmail(primary.emailAddress) : null;
};

// -> { email } or null. Never throws.
module.exports.resolveSailor = async (token) => {
  const keys = String(process.env.SAILOR_CLERK_SECRET_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  for (const key of keys) {
    let claims;
    try { claims = await module.exports._clerk.verifyToken(token, key); } catch { continue; }
    try {
      const email = module.exports.verifiedPrimaryEmail(await module.exports._clerk.getUser(key, claims.sub));
      return email ? { email } : null;
    } catch (err) {
      // @clerk/backend caches JWKS by kid across secret keys, so another
      // trusted instance's token can verify under this key; its user then
      // isn't here. User ids are unique across Clerk, so try the next key.
      if (err.status === 404) continue;
      console.error('Sailor lookup failed:', err.message);
      return null;
    }
  }
  return null;
};

const SIGN_IN = { error: 'Sign in required' };

async function sailorFromHeader(req, res, next, optional) {
  if (req.sailor) return next(); // the sailor rail already verified it
  try {
    const token = req.get('X-Sailor-Token');
    const sailor = token ? await module.exports.resolveSailor(token) : null;
    if (!sailor && optional) return next();
    if (!sailor) return res.status(401).json(SIGN_IN);
    req.sailor = sailor;
    next();
  } catch (err) { next(err); }
}

module.exports.authenticateSailor = (req, res, next) => sailorFromHeader(req, res, next, false);
// No header or a bad/expired token -> carry on signed out: routes that need
// a sailor (marinas with sailor_documents on) answer 'Sign in required'
// themselves, and a stale session never blocks a marina that doesn't.
module.exports.optionalSailor = (req, res, next) => sailorFromHeader(req, res, next, true);
