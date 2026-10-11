const crypto = require('crypto');

// The guest's capability for one booking: derived, never stored, so any
// code path (staff-action emails, the sweep, the confirm redirect) can
// rebuild the link. Rotating MARINA_BOOKING_TOKEN_SECRET invalidates every
// outstanding booking link -- acceptable, and the only way to revoke them.
function secret() {
  const s = process.env.MARINA_BOOKING_TOKEN_SECRET;
  if (!s) throw new Error('MARINA_BOOKING_TOKEN_SECRET is not set');
  return s;
}

function bookingToken(id) {
  return crypto.createHmac('sha256', secret()).update(String(id)).digest('base64url');
}

function bookingTokenMatches(id, token) {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(bookingToken(id));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { bookingToken, bookingTokenMatches };
