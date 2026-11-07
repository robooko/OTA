const pool = require('../db');
const ably = require('./ably'); // module object so checks can stub publishRoomBasketUpdated
const resend = require('./resend');
const { PAY_WINDOW_MINUTES } = require('./ratePlans');
const spa = require('../controllers/spa');

const OTA_API_BASE_URL = 'https://ota-u6ii.onrender.com';

// A room basket is a website card checkout (booking.website_checkout) that
// never got paid: pending_payment inside its pay window, or expired after it.
// It stays open for 7 days, or until the guest books or checks out again (any
// later non-cancelled booking closes it, so a retry replaces the old basket). Rows come out in the same
// shape as shop baskets, so <live-shop-baskets-feed> renders them as-is.
// A multi-room checkout is one basket: its first room (by id) stands for it,
// with every room as an item, and its own rooms never close it.
const OPEN = `
  b.status IN ('pending_payment', 'expired') AND b.created_at >= now() - interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM booking n
                   WHERE n.property_id = b.property_id AND n.guest_id = b.guest_id
                     AND n.created_at > b.created_at AND n.status <> 'cancelled'
                     AND (b.group_id IS NULL OR n.group_id IS DISTINCT FROM b.group_id))`;

const LEAD = `(b.group_id IS NULL OR NOT EXISTS (SELECT 1 FROM booking m WHERE m.group_id = b.group_id AND m.id < b.id))`;

// The booking's rooms: itself, plus the rest of its multi-room booking.
const MEMBERS = `(m.id = b.id OR (b.group_id IS NOT NULL AND m.group_id = b.group_id))`;

const NOT_OPTED_OUT = `NOT EXISTS (SELECT 1 FROM basket_reminder_opt_out o
  WHERE o.property_id = b.property_id AND lower(trim(o.email)) = lower(trim(g.email)))`;

// Never before the pay window closes: a guest still at the card step isn't abandoned.
const DUE_AT = `b.created_at + make_interval(mins => greatest(p.basket_reminder_delay_mins, ${PAY_WINDOW_MINUTES.api_key}))`;

const FROM = `
  FROM booking b
  JOIN guest g ON g.id = b.guest_id
  LEFT JOIN room r ON r.id = b.room_id
  JOIN room_type rt ON rt.id = b.room_type_id
  JOIN property p ON p.id = b.property_id`;

const FEED_SELECT = `
  SELECT b.id, CASE WHEN ${OPEN} THEN 'open' ELSE 'closed' END AS status,
         trim(g.first_name || ' ' || g.last_name) AS contact_name, g.email AS contact_email,
         (SELECT jsonb_agg(jsonb_build_object(
                   'item_name', mrt.name || ', ' || to_char(m.check_in, 'FMDD Mon') || ' – ' || to_char(m.check_out, 'FMDD Mon YYYY'),
                   'unit_price', m.total_price, 'quantity', 1) ORDER BY m.id)
            FROM booking m JOIN room_type mrt ON mrt.id = m.room_type_id WHERE ${MEMBERS}) AS items,
         (SELECT sum(m.total_price) FROM booking m WHERE ${MEMBERS}) AS items_subtotal, b.created_at AS updated_at,
         b.basket_reminder_sent_at AS reminder_sent_at,
         CASE WHEN p.basket_reminder_enabled AND b.basket_reminder_sent_at IS NULL
                   AND NULLIF(trim(g.email), '') IS NOT NULL AND ${NOT_OPTED_OUT}
              THEN ${DUE_AT} END AS reminder_due_at
  ${FROM}
  WHERE b.property_id = $1 AND b.website_checkout AND ${LEAD}`;

async function listOpenRoomBaskets(db, propertyId, limit) {
  return (await db.query(`${FEED_SELECT} AND ${OPEN} ORDER BY b.created_at DESC LIMIT $2`, [propertyId, limit])).rows;
}

// Republishes every recent basket of this booking's guest: a new booking can
// close an older basket, so the booking's own row isn't enough. Never throws.
function publishRoomBaskets(db, propertyId, guestId) {
  if (!guestId) return Promise.resolve();
  return db.query(`${FEED_SELECT} AND b.guest_id = $2 AND b.created_at >= now() - interval '8 days'`, [propertyId, guestId])
    .then(({ rows }) => Promise.all(rows.map((row) => ably.publishRoomBasketUpdated(propertyId, row))))
    .catch(console.error);
}

// At most one reminder per basket, ever: the UPDATE is the claim, and a failed
// send is not retried. Only expired checkouts: the room is released, so the
// email sends the guest back to the booking page, not to a held room.
const CLAIM_SQL = `
  UPDATE booking SET basket_reminder_sent_at = now()
  WHERE id IN (
    SELECT b.id ${FROM}
    WHERE b.website_checkout AND b.status = 'expired' AND ${OPEN} AND ${LEAD}
      AND b.basket_reminder_sent_at IS NULL
      AND p.basket_reminder_enabled
      AND (p.enabled_modules IS NULL OR p.enabled_modules ? 'rooms')
      AND NULLIF(trim(g.email), '') IS NOT NULL AND ${NOT_OPTED_OUT}
      AND ${DUE_AT} <= now()
    FOR UPDATE OF b SKIP LOCKED
  ) RETURNING id`;

async function claimDueRoomBaskets(db = pool) {
  const ids = (await db.query(CLAIM_SQL)).rows.map((r) => r.id);
  if (!ids.length) return [];
  return (await db.query(
    `SELECT b.*, g.first_name, g.email, rt.name AS room_type_name, p.name AS property_name, p.currency, p.room_booking_url
     ${FROM} WHERE b.id = ANY($1::uuid[])`, [ids]
  )).rows;
}

// Failure is logged and dropped -- the claim already happened, no retry.
async function sendOne(b, db) {
  try {
    const { branding } = await spa.resolveEmailBranding(b.property_id, undefined, undefined);
    const { rows: rooms } = await db.query(
      `SELECT mrt.name AS room_type_name, m.check_in, m.check_out, m.total_price
       FROM booking b JOIN booking m ON ${MEMBERS} JOIN room_type mrt ON mrt.id = m.room_type_id
       WHERE b.id = $1 ORDER BY m.id`, [b.id]);
    const emailId = await resend.sendBasketReminder({
      to: b.email,
      name: b.first_name,
      propertyName: b.property_name,
      branding,
      items: rooms.map((m) => ({ item_name: `${m.room_type_name}, ${m.check_in} to ${m.check_out}`, unit_price: m.total_price, quantity: 1 })),
      subtotal: rooms.reduce((a, m) => a + Number(m.total_price), 0).toFixed(2),
      currency: b.currency,
      returnUrl: b.room_booking_url,
      optOutUrl: `${OTA_API_BASE_URL}/api/basket-reminder-opt-out/${b.id}`,
      idempotencyKey: `room-basket-reminder-${b.id}`,
    });
    await db.query('UPDATE booking SET basket_reminder_resend_email_id = $1 WHERE id = $2', [emailId, b.id]);
  } catch (err) {
    console.error(`Room basket reminder ${b.id} failed:`, err.message);
  }
}

async function sweep(db = pool) {
  const claimed = await claimDueRoomBaskets(db);
  for (const b of claimed) {
    await sendOne(b, db); // sequential: small volumes
    publishRoomBaskets(db, b.property_id, b.guest_id);
  }
  return claimed.length;
}

module.exports = { listOpenRoomBaskets, publishRoomBaskets, claimDueRoomBaskets, sweep };
