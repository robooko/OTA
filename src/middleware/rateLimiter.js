const rateLimit = require('express-rate-limit');

// Guards the X-Api-Key rail shared by every guest-facing module (spa,
// restaurant, tours, golf, proshop, beach club, ...). Keyed by the raw
// header value rather than the validated property id, so it also throttles
// someone brute-forcing/guessing a key, not just abuse of a valid one.
const apiKeyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['x-api-key'],
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  },
});

module.exports = { apiKeyRateLimiter };
