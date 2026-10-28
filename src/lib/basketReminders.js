const pool = require('../db');
// Called through the module objects so checks can stub them.
const resend = require('./resend');
const { publishBasket } = require('./shopBaskets');
const spa = require('../controllers/spa');

const OTA_API_BASE_URL = 'https://ota-u6ii.onrender.com';

// At most one reminder per basket, ever: the UPDATE is the claim, and a
// failed send is not retried. Baskets older than 7 days are never claimed
// (switching reminders on doesn't backfill) and get expired instead.
const CLAIM_SQL = `
  UPDATE shop_basket b SET reminder_sent_at = $1::timestamptz
  FROM property p
  WHERE b.id IN (
    SELECT b2.id FROM shop_basket b2 JOIN property p2 ON p2.id = b2.property_id
    WHERE b2.status = 'open'
      AND NULLIF(trim(b2.contact_email), '') IS NOT NULL
      AND b2.reminder_sent_at IS NULL
      AND p2.basket_reminder_enabled
      AND (p2.enabled_modules IS NULL OR p2.enabled_modules ? 'shop')
      AND b2.updated_at <= $1::timestamptz - make_interval(mins => p2.basket_reminder_delay_mins)
      AND b2.updated_at >= $1::timestamptz - interval '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM basket_reminder_opt_out o
        WHERE o.property_id = b2.property_id AND lower(trim(o.email)) = lower(trim(b2.contact_email))
      )
    FOR UPDATE OF b2 SKIP LOCKED
  ) AND p.id = b.property_id
  RETURNING b.*, p.name AS property_name, p.email_branding, p.currency;
`;

async function claimDueBaskets(db = pool, at = new Date()) {
  return (await db.query(CLAIM_SQL, [at])).rows;
}

async function expireStaleBaskets(db = pool, at = new Date()) {
  return (await db.query(
    `UPDATE shop_basket SET status = 'expired'
      WHERE status = 'open' AND updated_at < $1::timestamptz - interval '7 days' RETURNING *`,
    [at]
  )).rows;
}

// Failure is logged and dropped -- the claim already happened, no retry.
async function sendOne(basket, db) {
  try {
    const { branding } = await spa.resolveEmailBranding(basket.property_id, undefined, undefined);
    const emailId = await resend.sendBasketReminder({
      to: basket.contact_email,
      name: basket.contact_name,
      propertyName: basket.property_name,
      branding,
      items: basket.items,
      subtotal: basket.items_subtotal,
      currency: basket.currency,
      returnUrl: basket.return_url,
      optOutUrl: `${OTA_API_BASE_URL}/api/basket-reminder-opt-out/${basket.id}`,
      idempotencyKey: `basket-reminder-${basket.id}`,
    });
    await db.query('UPDATE shop_basket SET reminder_resend_email_id = $1 WHERE id = $2', [emailId, basket.id]);
    basket.reminder_resend_email_id = emailId;
  } catch (err) {
    console.error(`Basket reminder ${basket.id} failed:`, err.message);
  }
}

async function sweep(db = pool, at = new Date()) {
  const claimed = await claimDueBaskets(db, at);
  for (const b of claimed) await sendOne(b, db); // sequential: small volumes
  const expired = await expireStaleBaskets(db, at);
  for (const b of [...claimed, ...expired]) {
    publishBasket(db, b.property_id, b.id);
  }
  return claimed.length;
}

function startBasketReminderJob() {
  const run = () =>
    sweep()
      .then((n) => { if (n > 0) console.log(`Basket reminders: sent ${n}`); })
      .catch((err) => console.error('Basket reminder sweep failed:', err.message));
  run();
  const timer = setInterval(run, 5 * 60 * 1000);
  timer.unref();
}

module.exports = { claimDueBaskets, expireStaleBaskets, sweep, startBasketReminderJob };
