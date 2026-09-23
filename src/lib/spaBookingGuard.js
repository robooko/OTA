// Guards on guest-rail (X-Api-Key) salon bookings -- the website form, and
// anything driving it (ChatGPT and other AI agents booking on a guest's
// behalf). See migrate-2026-09-23-spa-booking-guards.sql.
//
// 1. A cap: at most MAX_FUTURE_BOOKINGS upcoming appointments per email at a
//    property, so one person (or bot) can't block out a barber's week.
//    Counted on a normalised key so bob+1@gmail.com / b.o.b@gmail.com are
//    all "bob@gmail.com".
// 2. An email-confirmation hold: the booking is inserted as 'pending' --
//    holding the time so nobody else takes it -- and only becomes
//    'confirmed' when the guest clicks the link we email them. A made-up
//    address never gets the link, so the hold lapses after HOLD_MINUTES and
//    the time is released by the sweep below.
//
// Staff bookings (Clerk bearer) skip both. A signed-in site visitor whose
// verified email (member_email) matches the booking's contact_email skips
// the hold -- their address is already proven -- but still counts toward
// the cap.
const crypto = require('crypto');
const pool = require('../db');

const MAX_FUTURE_BOOKINGS = 3;
const HOLD_MINUTES = 30;

// Lowercased, +tag stripped, and for Gmail the dots removed (Gmail ignores
// them) and googlemail.com folded into gmail.com. The migration backfills
// with the same rule in SQL -- keep the two in step.
function emailKey(email) {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  const at = e.indexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Only the hash is stored: spa_appointment rows are returned whole (sa.*)
// by the list/get endpoints the same API key can call, so a stored raw
// token would let the booking caller confirm its own hold without ever
// reading the email.
function newConfirmToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function tokenMatches(token, hash) {
  if (!token || !hash) return false;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Serialises bookings for one email at one property for the rest of the
// transaction, so two concurrent requests can't both see 2 and book a 4th.
async function lockEmailKey(client, propertyId, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`spa-email:${propertyId}:${key}`]);
}

// Upcoming (start still in the future, property-local) pending or confirmed
// appointments for this email key at this property.
async function futureBookingCount(client, propertyId, key) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n
     FROM spa_appointment sa
     JOIN property p ON p.id = sa.property_id
     WHERE sa.property_id = $1
       AND sa.contact_email_key = $2
       AND sa.status IN ('pending', 'confirmed')
       AND (sa.appointment_date + sa.start_time) AT TIME ZONE p.timezone > now()`,
    [propertyId, key]
  );
  return rows[0].n;
}

// Every guest-rail insert goes through here, inside the booking's own
// transaction and before the INSERT. Returns { ok: false, code:
// 'booking_limit' } or { ok: true, hold: { status, confirm_token,
// confirm_token_hash, hold_expires_at } } -- hold.status is 'pending' or
// 'confirmed', the other hold fields null when confirmed.
async function checkGuestBooking(client, { property_id, contact_email, member_email }) {
  const key = emailKey(contact_email);
  await lockEmailKey(client, property_id, key);
  if (await futureBookingCount(client, property_id, key) >= MAX_FUTURE_BOOKINGS) {
    return { ok: false, code: 'booking_limit' };
  }
  if (member_email && emailKey(member_email) === key) {
    return { ok: true, hold: { status: 'confirmed', confirm_token: null, confirm_token_hash: null, hold_expires_at: null } };
  }
  const { token, hash } = newConfirmToken();
  return {
    ok: true,
    hold: {
      status: 'pending',
      confirm_token: token,
      confirm_token_hash: hash,
      hold_expires_at: new Date(Date.now() + HOLD_MINUTES * 60 * 1000),
    },
  };
}

// Releases lapsed holds. A pending appointment was never published to the
// live feeds or emailed as confirmed, so there's nothing to announce --
// just free the time.
async function sweep() {
  const { rowCount } = await pool.query(
    `UPDATE spa_appointment SET status = 'cancelled'
     WHERE status = 'pending' AND hold_expires_at <= now()`
  );
  return rowCount;
}

// Boot + every minute -- a lapsed hold keeps its time blocked until this
// runs, so it wants to be tighter than the 15-minute reminder sweep. The
// UPDATE hits a partial index and is usually a no-op.
function startHoldExpiryJob() {
  const run = () =>
    sweep()
      .then((n) => { if (n > 0) console.log(`Spa holds: released ${n}`); })
      .catch((err) => console.error('Spa hold sweep failed:', err.message));
  run();
  const timer = setInterval(run, 60 * 1000);
  timer.unref();
}

module.exports = {
  MAX_FUTURE_BOOKINGS,
  HOLD_MINUTES,
  emailKey,
  tokenMatches,
  checkGuestBooking,
  sweep,
  startHoldExpiryJob,
};
