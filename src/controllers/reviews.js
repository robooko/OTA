const pool = require('../db');
const { escapeHtml } = require('../lib/resend');
const { isValidDate } = require('../middleware/validate');

// Property-scoped: opting out of one venue's review requests says nothing
// about another the same person visits. Shared by the per-request route
// below and the legacy spa route (controllers/spa.js reviewOptOut).
async function optOut(db, propertyId, email) {
  if (!email) return;
  await db.query(
    `INSERT INTO review_request_opt_out (property_id, email) VALUES ($1, lower(trim($2))) ON CONFLICT DO NOTHING`,
    [propertyId, email]
  );
}

// GET, unauthenticated -- the request UUID is the capability (unguessable,
// only ever in that guest's own review email). Idempotent, so a mail
// client prefetching the link is harmless.
async function reviewOptOut(req, res, next) {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT rr.property_id, rr.email, p.name AS property_name
       FROM review_request rr JOIN property p ON p.id = rr.property_id WHERE rr.id = $1`,
      [req.params.request_id]
    );
    if (!r) return res.status(404).send('<p>That link is no longer valid.</p>');
    await optOut(pool, r.property_id, r.email);
    res.send(`<p>You won't be asked for a review by ${escapeHtml(r.property_name)} again.</p>`);
  } catch (err) {
    // A malformed UUID is a dead link, not a server error.
    if (err.code === '22P02') return res.status(404).send('<p>That link is no longer valid.</p>');
    next(err);
  }
}

// GET /api/review-requests -- what this property has asked for reviews,
// newest first. from/to (to exclusive) are local dates of when the guest
// was picked up. status: sent | unsent (failed sends awaiting retry, or
// given up after 3 attempts).
async function listRequests(req, res, next) {
  try {
    const { from, to, email, module, status } = req.query;
    if (from && !isValidDate(from)) return res.status(400).json({ error: 'Invalid from date' });
    if (to && !isValidDate(to)) return res.status(400).json({ error: 'Invalid to date' });
    if (status && !['sent', 'unsent'].includes(status)) return res.status(400).json({ error: "status must be 'sent' or 'unsent'" });

    const params = [req.property_id];
    const where = ['rr.property_id = $1'];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (from) add('(rr.created_at AT TIME ZONE p.timezone)::date >= ?', from);
    if (to) add('(rr.created_at AT TIME ZONE p.timezone)::date < ?', to);
    if (email) add('rr.email = lower(trim(?))', email);
    if (module) add('rr.module = ?', module);
    if (status) where.push(status === 'sent' ? 'rr.sent_at IS NOT NULL' : 'rr.sent_at IS NULL');

    // ponytail: hard cap, no paging -- narrow with from/to; add cursor paging if a property outgrows it
    const { rows } = await pool.query(
      `SELECT rr.id, rr.email, rr.contact_name, rr.module, rr.booking_id, rr.sent_at, rr.attempts,
              rr.resend_email_id, rr.created_at, (oo.email IS NOT NULL) AS opted_out
       FROM review_request rr
       JOIN property p ON p.id = rr.property_id
       LEFT JOIN review_request_opt_out oo ON oo.property_id = rr.property_id AND oo.email = rr.email
       WHERE ${where.join(' AND ')}
       ORDER BY rr.created_at DESC
       LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/review-requests/opt-outs -- guests who unsubscribed from this
// property's review emails, newest first.
async function listOptOuts(req, res, next) {
  try {
    const { rows } = await pool.query(
      'SELECT email, created_at FROM review_request_opt_out WHERE property_id = $1 ORDER BY created_at DESC',
      [req.property_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { optOut, reviewOptOut, listRequests, listOptOuts };
