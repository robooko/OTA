// Reservations a channel delivers, normalised by its adapter, become OTA
// bookings here (channel distribution spec §4). One transaction per message,
// idempotent on (channel_id, channel_ref), one channel_reservation_log row per
// message. Bad input is a 'rejected' outcome, never a throw.
//   reservation = { channel_ref, action: new|modify|cancel, room_code, rate_code,
//                   check_in, check_out, guests?, total_price, currency?,
//                   collect?: hotel|channel, guest: { first_name, last_name, email?, phone? } }
const pool = require('../../db');
const { isValidDate } = require('../../middleware/validate');
const { placeBooking, stayNights } = require('../roomPlacement');
const roomPayments = require('../roomPayments');
const { publishNewBooking, publishBookingStatusChanged, publishChannelReservationRejected } = require('../ably');

const IN_HOUSE = ['checked_in', 'checked_out'];
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function invalidField(r) {
  if (!nonEmpty(r.channel_ref) || r.channel_ref.length > 100) return 'channel_ref';
  if (!['new', 'modify', 'cancel'].includes(r.action)) return 'action';
  if (r.action === 'cancel') return null;
  if (!nonEmpty(r.room_code)) return 'room_code';
  if (!nonEmpty(r.rate_code)) return 'rate_code';
  if (!isValidDate(r.check_in)) return 'check_in';
  if (!isValidDate(r.check_out) || r.check_out <= r.check_in) return 'check_out';
  if (r.guests !== undefined && !(Number.isInteger(r.guests) && r.guests > 0)) return 'guests';
  if (!(typeof r.total_price === 'number' && Number.isFinite(r.total_price) && r.total_price >= 0)) return 'total_price';
  if (r.currency !== undefined && !nonEmpty(r.currency)) return 'currency';
  if (r.collect !== undefined && !['hotel', 'channel'].includes(r.collect)) return 'collect';
  const g = r.guest;
  if (!g || !nonEmpty(g.first_name) || !nonEmpty(g.last_name) || (g.email !== undefined && !nonEmpty(g.email))) return 'guest';
  return null;
}

const log = (db, channel, r, outcome, { booking_id = null, reason = null } = {}) => db.query(
  `INSERT INTO channel_reservation_log (property_id, channel_id, channel_ref, action, outcome, reason, booking_id, payload)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [channel.property_id, channel.id, typeof r.channel_ref === 'string' ? r.channel_ref.slice(0, 100) : null,
    typeof r.action === 'string' ? r.action.slice(0, 10) : null, outcome, reason, booking_id, JSON.stringify(r)]
);

// Mapping + currency checks shared by new and modify.
async function resolveStay(client, channel, r) {
  const mapping = (await client.query(
    `SELECT * FROM channel_mapping WHERE channel_id = $1 AND room_code = $2 AND rate_code = $3 AND status = 'active'`,
    [channel.id, r.room_code, r.rate_code])).rows[0];
  if (!mapping) return { reason: 'unknown room/rate code' };
  if (r.currency !== undefined) {
    const { currency } = (await client.query('SELECT currency FROM property WHERE id = $1', [channel.property_id])).rows[0];
    if (String(r.currency).toUpperCase() !== String(currency).toUpperCase()) return { reason: 'currency mismatch' };
  }
  const { rows: candidates } = await client.query(
    `SELECT id FROM room WHERE room_type_id = $1 AND property_id = $2 AND status = 'active' ORDER BY room_number`,
    [mapping.room_type_id, channel.property_id]);
  return { mapping, candidates };
}

// The channel's payment row tracks who holds the guest's money: present and
// completed for collect=channel, absent for collect=hotel.
async function syncChannelPayment(client, channel, r, booking) {
  const collect = r.collect ?? channel.collect;
  if (collect === 'channel') {
    const upd = await client.query(
      `UPDATE payment SET amount = $2 WHERE booking_id = $1 AND method = 'channel' AND status = 'completed'`,
      [booking.id, r.total_price]);
    if (!upd.rowCount) {
      await client.query(
        `INSERT INTO payment (property_id, booking_id, amount, method, status, paid_at) VALUES ($1, $2, $3, 'channel', 'completed', now())`,
        [channel.property_id, booking.id, r.total_price]);
    }
  } else {
    await client.query(`DELETE FROM payment WHERE booking_id = $1 AND method = 'channel' AND status = 'completed'`, [booking.id]);
  }
}

async function findGuest(client, channel, r) {
  const email = (r.guest.email ?? `${r.channel_ref}@channel-${channel.id}.invalid`).trim().toLowerCase();
  return (await client.query(
    `INSERT INTO guest (property_id, first_name, last_name, email, phone) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (property_id, email) DO UPDATE SET first_name = guest.first_name RETURNING id`,
    [channel.property_id, r.guest.first_name.trim(), r.guest.last_name.trim(), email, r.guest.phone ?? null])).rows[0].id;
}

async function lockByRef(client, channel, ref) {
  return (await client.query(
    'SELECT * FROM booking WHERE channel_id = $1 AND channel_ref = $2 FOR UPDATE', [channel.id, ref])).rows[0];
}

async function handleNew(client, channel, r) {
  const existing = (await client.query(
    'SELECT id FROM booking WHERE channel_id = $1 AND channel_ref = $2', [channel.id, r.channel_ref])).rows[0];
  if (existing) return { outcome: 'duplicate', booking_id: existing.id };
  const stay = await resolveStay(client, channel, r);
  if (stay.reason) return { outcome: 'rejected', reason: stay.reason };
  const guestId = await findGuest(client, channel, r);
  const { booked } = await placeBooking(client, {
    candidates: stay.candidates,
    nights: stayNights(r.check_in, r.check_out),
    insert: async (room) => (await client.query(
      `INSERT INTO booking (property_id, guest_id, room_id, check_in, check_out, guests, total_price, status, rate_plan_id, channel_id, channel_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, $9, $10) RETURNING *`,
      [channel.property_id, guestId, room.id, r.check_in, r.check_out, r.guests ?? 1, r.total_price.toFixed(2),
        stay.mapping.rate_plan_id, channel.id, r.channel_ref])).rows[0],
  });
  if (!booked) return { outcome: 'rejected', reason: 'no room available' };
  await syncChannelPayment(client, channel, r, booked);
  return { outcome: 'created', booking_id: booked.id };
}

async function handleModify(client, channel, r) {
  const booking = await lockByRef(client, channel, r.channel_ref);
  if (!booking) return { outcome: 'rejected', reason: 'unknown reservation' };
  if (IN_HOUSE.includes(booking.status)) return { outcome: 'rejected', reason: 'booking already in house' };
  if (booking.status === 'cancelled' || booking.status === 'expired') return { outcome: 'rejected', reason: 'booking cancelled' };
  const stay = await resolveStay(client, channel, r);
  if (stay.reason) return { outcome: 'rejected', reason: stay.reason };
  // Free the old nights, then place the new stay; the UPDATE moves this same
  // row, so it never collides with itself. Failure rolls everything back.
  await roomPayments.releaseAvailability(client, booking);
  const { booked } = await placeBooking(client, {
    candidates: stay.candidates,
    nights: stayNights(r.check_in, r.check_out),
    insert: async (room) => (await client.query(
      `UPDATE booking SET room_id = $2, check_in = $3, check_out = $4, guests = $5, total_price = $6, rate_plan_id = $7
       WHERE id = $1 RETURNING *`,
      [booking.id, room.id, r.check_in, r.check_out, r.guests ?? booking.guests, r.total_price.toFixed(2), stay.mapping.rate_plan_id])).rows[0],
  });
  if (!booked) return { outcome: 'rejected', reason: 'no room available' };
  await syncChannelPayment(client, channel, r, booked);
  return { outcome: 'modified', booking_id: booked.id };
}

async function handleCancel(client, channel, r) {
  const booking = await lockByRef(client, channel, r.channel_ref);
  if (!booking) return { outcome: 'rejected', reason: 'unknown reservation' };
  if (booking.status === 'cancelled' || booking.status === 'expired') return { outcome: 'duplicate', booking_id: booking.id };
  if (IN_HOUSE.includes(booking.status)) return { outcome: 'rejected', reason: 'booking already in house' };
  await client.query(`UPDATE booking SET status = 'cancelled', payment_due_at = NULL WHERE id = $1`, [booking.id]);
  await roomPayments.releaseAvailability(client, booking);
  await client.query(
    `UPDATE payment SET status = 'refunded' WHERE booking_id = $1 AND method = 'channel' AND status = 'completed'`, [booking.id]);
  return { outcome: 'cancelled', booking_id: booking.id };
}

const HANDLERS = { new: handleNew, modify: handleModify, cancel: handleCancel };

// quiet: skip the per-reservation availability refresh and Ably events (a
// bulk import refreshes once at the end and would otherwise flood the dashboard).
async function receiveReservation(channel, reservation, { quiet = false } = {}) {
  const r = reservation && typeof reservation === 'object' && !Array.isArray(reservation) ? reservation : {};
  const bad = invalidField(r);
  if (bad) {
    const result = { outcome: 'rejected', reason: `invalid reservation: ${bad}` };
    await log(pool, channel, r, result.outcome, result);
    return result;
  }

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    result = await HANDLERS[r.action](client, channel, r);
    if (result.outcome === 'rejected') {
      await client.query('ROLLBACK');
    } else {
      await log(client, channel, r, result.outcome, result);
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (result.outcome === 'rejected') {
    await log(pool, channel, r, result.outcome, result);
    if (result.reason === 'no room available' && !quiet) {
      publishChannelReservationRejected(channel.property_id, { channel_id: channel.id, channel_ref: r.channel_ref, reason: result.reason })
        .catch((err) => console.error('Ably publish failed:', err.message));
    }
    return result;
  }
  if (result.outcome !== 'duplicate' && !quiet) {
    await roomPayments.refreshAvailabilityView();
    const full = await roomPayments.fetchJoinedBooking(result.booking_id);
    const publish = result.outcome === 'created' ? publishNewBooking : publishBookingStatusChanged;
    publish(channel.property_id, full).catch((err) => console.error('Ably publish failed:', err.message));
  }
  return result;
}

module.exports = { receiveReservation };
