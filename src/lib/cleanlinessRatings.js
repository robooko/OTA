const crypto = require('crypto');
const pool = require('../db');
// Called through the module objects so scripts/check-housekeeping.js can stub them.
const resend = require('./resend');
const spa = require('../controllers/spa');
const { OTA_API_BASE_URL } = require('./reviewRequester');

// The guest's post-stay cleanliness rating: its own short email and a plain
// form, separate from Google review requests (housekeeping spec). One per
// room booking, housekeeping properties only; respects review opt-outs.

const MAX_ATTEMPTS = 3;

// Claims checkouts from the last two local days (switching housekeeping on
// never backfills history). The INSERT is the claim: UNIQUE booking_id.
// $1 is "now", injectable so the check can move the clock.
const CLAIM_SQL = `
  INSERT INTO cleanliness_rating (property_id, booking_id, email, token)
  SELECT b.property_id, b.id, lower(trim(g.email)), replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  FROM booking b
  JOIN guest g    ON g.id = b.guest_id
  JOIN property p ON p.id = b.property_id
  WHERE b.status = 'checked_out'
    AND p.enabled_modules IS NOT NULL AND p.enabled_modules ? 'housekeeping'
    AND b.check_out BETWEEN ($1::timestamptz AT TIME ZONE p.timezone)::date - 2 AND ($1::timestamptz AT TIME ZONE p.timezone)::date
    AND trim(coalesce(g.email, '')) <> ''
    AND NOT EXISTS (SELECT 1 FROM review_request_opt_out o
                    WHERE o.property_id = b.property_id AND lower(trim(o.email)) = lower(trim(g.email)))
  ON CONFLICT (booking_id) DO NOTHING
  RETURNING *`;

async function claimDue(db = pool, now = new Date()) {
  return (await db.query(CLAIM_SQL, [now])).rows;
}

const formUrl = (token) => `${OTA_API_BASE_URL}/api/cleanliness/${token}`;

async function sendOne(row, db = pool) {
  try {
    const { rows: [p] } = await db.query('SELECT name FROM property WHERE id = $1', [row.property_id]);
    const { rows: [g] } = await db.query('SELECT g.first_name FROM booking b JOIN guest g ON g.id = b.guest_id WHERE b.id = $1', [row.booking_id]);
    const { branding } = await spa.resolveEmailBranding(row.property_id, undefined, undefined);
    await resend.sendCleanlinessRequest({
      to: row.email,
      name: g?.first_name,
      propertyName: p.name,
      branding,
      formUrl: formUrl(row.token),
      optOutUrl: `${formUrl(row.token)}/opt-out`,
      idempotencyKey: `cleanliness/${row.id}`,
    });
  } catch (err) {
    console.error(`Cleanliness rating ${row.id} failed:`, err.message);
    await db.query(
      `UPDATE cleanliness_rating SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END
       WHERE id = $1`,
      [row.id, MAX_ATTEMPTS]
    ).catch((e) => console.error(`Cleanliness rating ${row.id} release failed:`, e.message));
    return false;
  }
  await db.query(`UPDATE cleanliness_rating SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1`, [row.id])
    .catch((e) => console.error(`Cleanliness rating ${row.id} sent but not recorded:`, e.message));
  return true;
}

// New claims plus earlier failures still under the attempt cap. Sequential:
// a property's checkouts per 15 minutes are few.
async function runOnce(now = new Date(), db = pool) {
  await claimDue(db, now);
  const { rows } = await db.query(`SELECT * FROM cleanliness_rating WHERE status = 'pending' AND attempts < $1 ORDER BY created_at`, [MAX_ATTEMPTS]);
  let n = 0;
  for (const row of rows) if (await sendOne(row, db)) n++;
  return n;
}

// Boot + every 15 minutes, same pattern as startReviewRequestJob.
function startCleanlinessRatingJob() {
  const run = () =>
    runOnce()
      .then((n) => { if (n > 0) console.log(`Cleanliness ratings: sent ${n}`); })
      .catch((err) => console.error('Cleanliness rating sweep failed:', err.message));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

// ── The guest's form ────────────────────────────────────────────────────────

function page(title, body) {
  const t = resend.escapeHtml(title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:16px;color:#1a1a1a;line-height:1.5;max-width:480px;margin:40px auto;padding:0 20px;">
<h1 style="font-size:22px;margin:0 0 16px;">${t}</h1>${body}</body></html>`;
}

async function findByToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT c.*, p.name AS property_name FROM cleanliness_rating c JOIN property p ON p.id = c.property_id WHERE c.token = $1`,
    [token]
  );
  return rows[0] ?? null;
}

function formHtml(row, error) {
  const esc = resend.escapeHtml;
  const radios = [1, 2, 3, 4, 5].map((n) => `<label style="display:inline-block;margin-right:14px;font-size:18px;">
      <input type="radio" name="rating" value="${n}" required ${row.rating === n ? 'checked' : ''}> ${n}</label>`).join('');
  return page(`How clean was your room at ${row.property_name}?`, `
${error ? `<p style="color:#b00020;">${esc(error)}</p>` : ''}
<form method="post">
  <p style="margin:0 0 8px;">1 = not clean, 5 = spotless</p>
  <div style="margin:0 0 20px;">${radios}</div>
  <label for="comment" style="display:block;margin:0 0 6px;">Anything we should know? (optional)</label>
  <textarea id="comment" name="comment" maxlength="2000" rows="4" style="width:100%;font:inherit;padding:8px;box-sizing:border-box;">${esc(row.comment ?? '')}</textarea>
  <button type="submit" style="margin-top:16px;background:#1a1a1a;color:#fff;border:0;border-radius:6px;padding:10px 22px;font:inherit;font-weight:600;">Send</button>
</form>`);
}

async function showForm(req, res, next) {
  try {
    const row = await findByToken(req.params.token);
    if (!row) return res.status(404).send(page('Link not found', '<p>This rating link isn\'t valid.</p>'));
    res.send(formHtml(row));
  } catch (err) { next(err); }
}

async function submitForm(req, res, next) {
  try {
    const row = await findByToken(req.params.token);
    if (!row) return res.status(404).send(page('Link not found', '<p>This rating link isn\'t valid.</p>'));
    const rating = Number(req.body?.rating);
    const comment = typeof req.body?.comment === 'string' && req.body.comment.trim() ? req.body.comment.trim() : null;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).send(formHtml(row, 'Please choose a rating from 1 to 5.'));
    if (comment && comment.length > 2000) return res.status(400).send(formHtml(row, 'Please keep your comment under 2000 characters.'));
    await pool.query('UPDATE cleanliness_rating SET rating = $1, comment = $2, rated_at = now() WHERE id = $3', [rating, comment, row.id]);
    res.send(page('Thank you', `<p>Thanks for rating your room at ${resend.escapeHtml(row.property_name)}.</p>`));
  } catch (err) { next(err); }
}

async function optOut(req, res, next) {
  try {
    const row = await findByToken(req.params.token);
    if (!row) return res.status(404).send(page('Link not found', '<p>This link isn\'t valid.</p>'));
    await pool.query('INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.property_id, row.email]);
    res.send(page('Unsubscribed', `<p>You won't get these emails from ${resend.escapeHtml(row.property_name)} again.</p>`));
  } catch (err) { next(err); }
}

module.exports = { claimDue, runOnce, startCleanlinessRatingJob, showForm, submitForm, optOut, MAX_ATTEMPTS };
