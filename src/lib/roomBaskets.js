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
const OPEN = `
  b.status IN ('pending_payment', 'expired') AND b.created_at >= now() - interval '7 days'
  AND NOT EXISTS (SELECT 1 FROM booking n
                   WHERE n.property_id = b.property_id AND n.guest_id = b.guest_id
                     AND n.created_at > b.created_at AND n.status <> 'cancelled')`;

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
         jsonb_build_array(jsonb_build_object(
           'item_name', rt.name || ', ' || to_char(b.check_in, 'FMDD Mon') || ' – ' || to_char(b.check_out, 'FMDD Mon YYYY'),
           'unit_price', b.total_price, 'quantity', 1)) AS items,
         b.total_price AS items_subtotal, b.created_at AS updated_at,
         b.basket_reminder_sent_at AS reminder_sent_at,
         CASE WHEN p.basket_reminder_enabled AND b.basket_reminder_sent_at IS NULL
                   AND NULLIF(trim(g.email), '') IS NOT NULL AND ${NOT_OPTED_OUT}
              THEN ${DUE_AT} END AS reminder_due_at
  ${FROM}
  WHERE b.property_id = $1 AND b.website_checkout`;

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
    WHERE b.website_checkout AND b.status = 'expired' AND ${OPEN}
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
    const emailId = await resend.sendBasketReminder({
      to: b.email,
      name: b.first_name,
      propertyName: b.property_name,
      branding,
      items: [{ item_name: `${b.room_type_name}, ${b.check_in} to ${b.check_out}`, unit_price: b.total_price, quantity: 1 }],
      subtotal: b.total_price,
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
