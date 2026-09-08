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

module.exports = { generateOrderReference, normaliseReference };
