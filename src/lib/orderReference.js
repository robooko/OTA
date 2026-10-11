const crypto = require('crypto');

// No 0/O/1/I: guests read these off a confirmation email and type them into
// a return form, so ambiguous glyphs are left out. 32^6 ≈ 1.07 billion codes
// per property -- collisions are checked for anyway (createOrder).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LENGTH = 6;

function generateOrderReference() {
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

// What a guest typed -> what's stored: trimmed, upper-cased. Never throws.
function normaliseReference(value) {
  return String(value ?? '').trim().toUpperCase();
}

// Picks a reference not yet used by this property. Checked first rather than
// caught on the unique index, because a unique-violation would abort the
// caller's transaction.
async function allocateOrderReference(db, propertyId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateOrderReference();
    const { rows } = await db.query('SELECT 1 FROM proshop_order WHERE property_id = $1 AND reference = $2', [propertyId, candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error('Could not allocate an order reference');
}

module.exports = { generateOrderReference, allocateOrderReference, normaliseReference };
