const pool = require('../db');
const { escapeHtml } = require('../lib/resend');

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

module.exports = { optOut, reviewOptOut };
