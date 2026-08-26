const crypto = require('crypto');
const pool = require('../db');

// Scan-to-order session join codes. A restaurant with require_join_code on
// stamps a 4-digit code onto each newly opened table session; api-key
// callers (the guest site's proxy rail) must present it via X-Session-Code
// on session-scoped requests. Staff (Clerk bearer) bypass entirely.
//
// The code is stored plaintext by design: a 4-digit space gains nothing
// meaningful from hashing (offline brute force of any hash is instant), so
// protection comes from the online attempt lockout below.

const MAX_ATTEMPTS = 10;

function generateJoinCode() {
  return crypto.randomInt(10000).toString().padStart(4, '0');
}

// Shallow copy minus the secret columns -- applied to every api-key response
// body and every Ably payload built from a session row.
function sanitizeSession(row) {
  const { join_code, join_code_attempts, ...safe } = row;
  return safe;
}

// Gate for one session-scoped request. Returns null when access is allowed,
// else { status, body } for the caller to send (rolling back its own
// transaction first if it has one).
//
// The attempt-counter writes always go through the shared pool -- never a
// caller's transaction client -- so a rolled-back order transaction can't
// also roll back the guess penalty.
async function verifyJoinCode(session, req) {
  if (session.join_code == null) return null; // uncoded / grandfathered
  if (req.auth_method !== 'api_key') return null; // staff bypass

  // Lockout is checked BEFORE comparing, so a locked session rejects even
  // the correct code until staff rotates -- otherwise interleaving the real
  // code with guesses would make the lockout a no-op.
  if (session.join_code_attempts >= MAX_ATTEMPTS) {
    return { status: 423, body: { error: 'Session locked after too many join code attempts' } };
  }

  const supplied = req.headers['x-session-code'];
  // Missing is not wrong: a client that simply hasn't implemented the
  // header must not burn the lockout budget.
  if (supplied == null || supplied === '') {
    return { status: 403, body: { error: 'Join code required' } };
  }

  const expected = Buffer.from(String(session.join_code));
  const given = Buffer.from(String(supplied).padEnd(expected.length, ' ').slice(0, expected.length));
  const match = String(supplied).length === String(session.join_code).length && crypto.timingSafeEqual(expected, given);

  if (!match) {
    await pool.query(
      `UPDATE restaurant_table_session SET join_code_attempts = join_code_attempts + 1 WHERE id = $1`,
      [session.id]
    );
    return { status: 403, body: { error: 'Invalid join code' } };
  }

  // Reset on success. Trade-off, accepted deliberately: a legit guest's
  // traffic refreshes an attacker's guess budget -- the alternative locks
  // out the real party after 10 shared typos across the table.
  if (session.join_code_attempts > 0) {
    await pool.query(
      `UPDATE restaurant_table_session SET join_code_attempts = 0 WHERE id = $1 AND join_code_attempts > 0`,
      [session.id]
    );
  }
  return null;
}

module.exports = { generateJoinCode, sanitizeSession, verifyJoinCode, MAX_ATTEMPTS };
