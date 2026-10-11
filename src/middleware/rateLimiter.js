const net = require('net');
const rateLimit = require('express-rate-limit');

// Guards the X-Api-Key rail shared by every guest-facing module (spa,
// restaurant, tours, golf, proshop, beach club, marina, ...). Keyed by the
// raw header value rather than the validated property id, so it also
// throttles someone brute-forcing/guessing a key, not just abuse of a valid
// one. When a site's forwarder sends X-Client-Ip, the visitor's IP is added
// so one visitor can't exhaust a property's budget for every module (the
// header only splits buckets -- the key itself is still required).
const apiKeyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = String(req.headers['x-client-ip'] || '').trim();
    return net.isIP(ip) ? `${req.headers['x-api-key']}|${ip}` : req.headers['x-api-key'];
  },
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  },
});

module.exports = { apiKeyRateLimiter };
