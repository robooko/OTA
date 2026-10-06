const pool = require('../db');
// Called through the module objects (not destructured) so
// scripts/check-review-requests.js can stub them.
const resend = require('./resend');
const spa = require('../controllers/spa');

// Same public host used elsewhere for a link that has to work outside a
// request (src/controllers/property.js's VERCEL_CALLBACK_URL).
const OTA_API_BASE_URL = 'https://ota-u6ii.onrender.com';

const MAX_ATTEMPTS = 3;

// One request per guest per visit, across every module in review_candidate
// (see docs/superpowers/specs/2026-10-06-review-requests-all-modules-design.md).
// A guest (property + lowercased email) is due when a booking of theirs
// ended at least delay ago (but within 2 days -- switching reviews on never
// backfills history), their visit is over (no room stay in progress or
// starting within a day, and nothing else of theirs ending within a day --
// a regular who's back next week is still asked now; the cooldown handles
// repeat visits), nobody asked them there within the cooldown, and they
// haven't opted out. The trigger is their most recently ended booking.
//
// The INSERT is the claim: UNIQUE (module, booking_id) + ON CONFLICT means
// two overlapping sweeps can never send for the same booking. $1 is "now",
// injectable so scripts/check-review-requests.js can move the clock.
const CLAIM_SQL = `
  WITH due AS (
    SELECT DISTINCT ON (c.property_id, c.email)
           c.property_id, c.email, c.contact_name, c.module, c.booking_id
    FROM review_candidate c
    JOIN property p ON p.id = c.property_id
    WHERE p.review_request_enabled
      AND p.review_url IS NOT NULL
      AND (p.enabled_modules IS NULL OR p.enabled_modules ? c.module)
      AND c.ended_at <= $1::timestamptz - make_interval(mins => p.review_request_delay_mins)
      AND c.ended_at >= $1::timestamptz - interval '2 days'
      AND NOT EXISTS (
        SELECT 1 FROM review_candidate f
        WHERE f.property_id = c.property_id AND f.email = c.email
          AND (p.enabled_modules IS NULL OR p.enabled_modules ? f.module)
          AND f.ended_at > $1::timestamptz
          AND (f.ended_at <= $1::timestamptz + interval '24 hours'
               OR f.started_at <= $1::timestamptz + interval '24 hours')
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_request r
        WHERE r.property_id = c.property_id AND r.email = c.email
          AND r.created_at >= $1::timestamptz - make_interval(days => p.review_request_cooldown_days)
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_request_opt_out o
        -- trim: rows written by the old spa opt-out were lower()ed, not trimmed
        WHERE o.property_id = c.property_id AND lower(trim(o.email)) = c.email
      )
    ORDER BY c.property_id, c.email, c.ended_at DESC
  )
  INSERT INTO review_request (property_id, email, contact_name, module, booking_id, sent_at, created_at)
  SELECT property_id, email, contact_name, module, booking_id, $1::timestamptz, $1::timestamptz FROM due
  ON CONFLICT (module, booking_id) DO NOTHING
  RETURNING id, property_id, email, contact_name, module, booking_id;
`;

// A failed send leaves sent_at NULL; the next sweep reclaims it (setting
// sent_at in the same UPDATE, so it can't be claimed twice) until
// MAX_ATTEMPTS. attempts starts at 1 on the original claim.
const RETRY_SQL = `
  UPDATE review_request rr
  SET sent_at = $1::timestamptz, attempts = rr.attempts + 1
  FROM property p
  WHERE p.id = rr.property_id AND p.review_request_enabled AND p.review_url IS NOT NULL
    AND rr.sent_at IS NULL AND rr.attempts < $2
    AND NOT EXISTS (SELECT 1 FROM review_request_opt_out o WHERE o.property_id = rr.property_id AND lower(trim(o.email)) = rr.email)
  RETURNING rr.id, rr.property_id, rr.email, rr.contact_name, rr.module, rr.booking_id;
`;

async function claimDue(db = pool, at = new Date()) {
  return (await db.query(CLAIM_SQL, [at])).rows;
}

async function claimRetries(db = pool, at = new Date()) {
  return (await db.query(RETRY_SQL, [at, MAX_ATTEMPTS])).rows;
}

// Everything that can fail is inside the try, so one bad row is released
// for retry rather than aborting the sweep (rows claimed after it would
// otherwise sit "sent" forever, blocked by the cooldown). The Resend id is
// recorded outside it: once Resend has accepted the email, a DB hiccup must
// not release the row and send it again. The idempotency key makes a retry
// after a network timeout a no-op at Resend too (24 h window).
async function sendOne(claimed, db = pool) {
  let emailId;
  try {
    const { rows: [p] } = await db.query('SELECT name, review_url, fallback_email FROM property WHERE id = $1', [claimed.property_id]);
    const { branding } = await spa.resolveEmailBranding(claimed.property_id, undefined, undefined);
    emailId = await resend.sendReviewRequest({
      to: claimed.email,
      name: claimed.contact_name,
      propertyName: p.name,
      branding,
      reviewUrl: p.review_url,
      optOutUrl: `${OTA_API_BASE_URL}/api/review-opt-out/${claimed.id}`,
      replyTo: p.fallback_email || undefined,
      idempotencyKey: `review-request/${claimed.id}`,
    });
  } catch (err) {
    console.error(`Review request ${claimed.id} failed:`, err.message);
    // Released for the retry sweep; attempts (already counted) bounds it.
    await db.query('UPDATE review_request SET sent_at = NULL WHERE id = $1', [claimed.id])
      .catch((e) => console.error(`Review request ${claimed.id} release failed:`, e.message));
    return;
  }
  await db.query('UPDATE review_request SET resend_email_id = $1 WHERE id = $2', [emailId, claimed.id])
    .catch((e) => console.error(`Review request ${claimed.id} sent (${emailId}) but not recorded:`, e.message));
}

async function sweep(db = pool, at = new Date()) {
  const claimed = [...await claimRetries(db, at), ...await claimDue(db, at)];
  for (const row of claimed) {
    // Sequential, not Promise.all -- volumes are small (one property's
    // worth of finished visits per 15 minutes).
    await sendOne(row, db);
  }
  return claimed.length;
}

// Boot + every 15 minutes, same in-process setInterval pattern as
// availabilitySeeder.js/teeTimeSeeder.js.
function startReviewRequestJob() {
  const run = () =>
    sweep()
      .then((n) => { if (n > 0) console.log(`Review requests: sent ${n}`); })
      .catch((err) => console.error('Review request sweep failed:', err.message));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

module.exports = { claimDue, claimRetries, sweep, startReviewRequestJob, MAX_ATTEMPTS };
