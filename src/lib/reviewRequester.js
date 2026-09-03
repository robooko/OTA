const pool = require('../db');
const { sendReviewRequest } = require('./resend');
const { getFullAppointmentForEmail, resolveEmailBranding } = require('../controllers/spa');

// Same public host used elsewhere for a link that has to work outside a
// request (src/controllers/property.js's VERCEL_CALLBACK_URL).
const OTA_API_BASE_URL = 'https://ota-u6ii.onrender.com';

const MAX_ATTEMPTS = 3;

// One statement is the whole idempotency guarantee: sent_at is set in the
// same UPDATE that selects the row, so Postgres row-locks it and a second
// process (or an overlapping sweep) running this identical statement can
// never claim it twice. See docs/superpowers/specs/2026-09-01-spa-review-requests-design.md.
const CLAIM_SQL = `
  UPDATE spa_appointment sa
  SET review_request_sent_at = now(),
      review_request_attempts = sa.review_request_attempts + 1
  FROM property p
  WHERE p.id = sa.property_id
    AND p.review_request_enabled
    AND p.review_url IS NOT NULL
    AND sa.status = 'confirmed'
    AND sa.contact_email IS NOT NULL
    AND sa.review_request_sent_at IS NULL
    AND sa.review_request_attempts < $1
    -- ended at least delay_mins ago, in the property's own timezone --
    -- appointment_date/end_time carry no timezone of their own.
    AND (sa.appointment_date + sa.end_time) AT TIME ZONE p.timezone
          <= now() - (p.review_request_delay_mins || ' minutes')::interval
    -- never backfill history when the switch is first flipped on
    AND sa.appointment_date >= CURRENT_DATE - 2
    -- cooldown: nobody asked at this property in the window
    AND NOT EXISTS (
      SELECT 1 FROM spa_appointment prev
      WHERE prev.property_id = sa.property_id
        AND lower(prev.contact_email) = lower(sa.contact_email)
        AND prev.id <> sa.id
        AND prev.review_request_sent_at >= now() - (p.review_request_cooldown_days || ' days')::interval
    )
    AND NOT EXISTS (
      SELECT 1 FROM review_request_opt_out o
      WHERE o.property_id = sa.property_id AND o.email = lower(sa.contact_email)
    )
  RETURNING sa.id, sa.property_id, sa.review_request_attempts;
`;

// On a Resend failure, reset sent_at so the next tick retries -- the
// attempts counter (already incremented by the claim) is what actually
// stops it retrying forever, once MAX_ATTEMPTS is reached.
async function releaseForRetry(appointmentId) {
  await pool.query('UPDATE spa_appointment SET review_request_sent_at = NULL WHERE id = $1', [appointmentId]);
}

async function sendOne(claimed) {
  const full = await getFullAppointmentForEmail(claimed.id);
  if (!full) return; // appointment vanished between claim and send; nothing to release

  const { branding } = await resolveEmailBranding(claimed.property_id, undefined, undefined);
  const { rows: [p] } = await pool.query('SELECT review_url FROM property WHERE id = $1', [claimed.property_id]);
  const optOutUrl = `${OTA_API_BASE_URL}/api/spa/review-opt-out/${claimed.id}`;

  try {
    const emailId = await sendReviewRequest(full, full.property_name, branding, p.review_url, optOutUrl);
    await pool.query('UPDATE spa_appointment SET review_request_resend_email_id = $1 WHERE id = $2', [emailId, claimed.id]);
  } catch (err) {
    console.error(`Review request failed for appointment ${claimed.id}:`, err.message);
    if (claimed.review_request_attempts < MAX_ATTEMPTS) await releaseForRetry(claimed.id);
  }
}

async function sweep() {
  const { rows: claimed } = await pool.query(CLAIM_SQL, [MAX_ATTEMPTS]);
  for (const row of claimed) {
    // Sequential, not Promise.all -- this runs every 15 minutes and volumes
    // are small (one salon's worth of same-day appointments); no need for
    // the concurrency or partial-failure handling a batch send would need.
    await sendOne(row);
  }
  return claimed.length;
}

// Boot + every 15 minutes, same in-process setInterval pattern as
// availabilitySeeder.js/teeTimeSeeder.js -- daily is too coarse for "a
// couple of hours after the cut, same evening".
function startReviewRequestJob() {
  const run = () =>
    sweep()
      .then((n) => { if (n > 0) console.log(`Review requests: sent ${n}`); })
      .catch((err) => console.error('Review request sweep failed:', err.message));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

module.exports = { sweep, startReviewRequestJob };
