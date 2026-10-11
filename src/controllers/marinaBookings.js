const pool = require('../db');
const { isValidDate, isValidUuid } = require('../middleware/validate');
const q = require('../lib/marinaQueries');
const life = require('../lib/marinaLifecycle');
const { priceStay } = require('../lib/marinaPricing');
const { emailKey } = require('../lib/spaBookingGuard');

// Staff booking routes (authenticateOrApiKey, so MCP tools work over a
// key). Holds are a guest's in-flight checkout: hidden from staff lists.

async function listBookings(req, res, next) {
  try {
    const { from, to, status, berth_id, marina_id } = req.query;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const where = ['mb.property_id = $1', "mb.status <> 'hold'"];
    const params = [req.property_id];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
    if (from) { if (!isValidDate(from)) return res.status(400).json({ error: 'Invalid from' }); add('(mb.departure IS NULL OR mb.departure > ?)', from); }
    if (to) { if (!isValidDate(to)) return res.status(400).json({ error: 'Invalid to' }); add('mb.arrival < ?', to); }
    if (status) { if (!['pending', 'confirmed', 'declined', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' }); add('mb.status = ?', status); }
    if (berth_id) { if (!isValidUuid(berth_id)) return res.status(400).json({ error: 'Invalid berth_id' }); add('mb.berth_id = ?', berth_id); }
    if (marina_id) { if (!isValidUuid(marina_id)) return res.status(400).json({ error: 'Invalid marina_id' }); add('mb.marina_id = ?', marina_id); }
    const w = where.join(' AND ');
    const [{ rows: [{ total }] }, { rows }] = await Promise.all([
      pool.query(`SELECT count(*)::int AS total FROM marina_booking mb WHERE ${w}`, params),
      pool.query(`SELECT mb.id, mb.marina_id, m.name AS marina_name, mb.berth_id, b.label AS berth_label, mb.contact_name, mb.contact_email,
                         mb.contact_phone, mb.boat_name, mb.boat_length_m, mb.arrival, mb.departure, mb.status, mb.source,
                         mb.total_price, mb.currency, mb.payment_status, mb.payment_error, mb.hold_expires_at, mb.created_at
                  FROM marina_booking mb JOIN marina_berth b ON b.id = mb.berth_id JOIN marina m ON m.id = mb.marina_id
                  WHERE ${w} ORDER BY mb.arrival, b.label LIMIT ${limit} OFFSET ${offset}`, params),
    ]);
    res.json({ total, data: rows });
  } catch (err) { next(err); }
}

async function bookingOr404(req, res) {
  if (!isValidUuid(req.params.id)) { res.status(404).json({ error: 'Booking not found' }); return null; }
  const b = await q.joinedBooking(pool, req.params.id);
  if (!b || b.property_id !== req.property_id) { res.status(404).json({ error: 'Booking not found' }); return null; }
  return b;
}

async function getBooking(req, res, next) {
  try {
    const b = await bookingOr404(req, res);
    if (!b) return;
    const [docs, sig] = await Promise.all([
      pool.query('SELECT id, requirement_id, type, file_name, content_type, size_bytes, status, expiry_date, submitted_at, verified_at, file_deleted_at FROM marina_document WHERE booking_id = $1 ORDER BY submitted_at', [b.id]),
      pool.query('SELECT template_id, signer_email, agreed_at FROM marina_contract_signature WHERE booking_id = $1', [b.id]),
    ]);
    const { confirm_token_hash, ...safe } = b;
    res.json({ ...safe, documents: docs.rows, signature: sig.rows[0] || null });
  } catch (err) { next(err); }
}

// Staff create: any dates (past included), open-ended allowed, optional
// total_price override, straight to pending or confirmed. Never swept.
async function createBooking(req, res, next) {
  try {
    const b = req.body || {};
    if (!isValidUuid(b.berth_id)) return res.status(400).json({ error: 'berth_id is required' });
    if (typeof b.contact_name !== 'string' || !b.contact_name.trim()) return res.status(400).json({ error: 'contact_name is required' });
    if (!isValidDate(b.arrival)) return res.status(400).json({ error: 'arrival must be YYYY-MM-DD' });
    if (b.departure != null && (!isValidDate(b.departure) || b.departure <= b.arrival)) return res.status(400).json({ error: 'departure must be YYYY-MM-DD after arrival, or null for open-ended' });
    const status = b.status ?? 'confirmed';
    if (!['pending', 'confirmed'].includes(status)) return res.status(400).json({ error: 'status must be pending or confirmed' });
    if (b.total_price != null && !(Number(b.total_price) >= 0)) return res.status(400).json({ error: 'total_price must be a non-negative number' });
    const { rows: [berth] } = await pool.query("SELECT * FROM marina_berth WHERE id = $1 AND property_id = $2 AND status <> 'inactive'", [b.berth_id, req.property_id]);
    if (!berth) return res.status(404).json({ error: 'Berth not found' });
    const len = b.boat_length_m != null ? Number(b.boat_length_m) : null;
    const total = b.total_price != null ? Number(b.total_price).toFixed(2)
      : priceStay({ berth, tiers: await q.activeTiers(pool, berth.marina_id), arrival: b.arrival, departure: b.departure ?? null, boatLengthM: len, boatBeamM: b.boat_beam_m != null ? Number(b.boat_beam_m) : null }).total_price;
    const { rows: [row] } = await pool.query(
      `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, contact_email, contact_email_key, contact_phone,
         boat_name, boat_length_m, boat_beam_m, arrival, departure, status, source, locale, total_price, currency, notes)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'staff', $14, $15, upper(p.currency), $16 FROM property p WHERE p.id = $1
       RETURNING id`,
      [req.property_id, berth.marina_id, berth.id, b.contact_name.trim().slice(0, 100), b.contact_email || null, b.contact_email ? emailKey(b.contact_email) : null,
        b.contact_phone || null, b.boat_name || null, len, b.boat_beam_m ?? null, b.arrival, b.departure ?? null, status,
        ['en', 'it', 'fr', 'es'].includes(b.locale) ? b.locale : 'en', total, b.notes || null]);
    const booking = await q.joinedBooking(pool, row.id);
    life.afterChange(null, booking);
    res.status(201).json(booking);
  } catch (err) {
    if (err.code === '23P01') return res.status(409).json({ error: 'That berth is already booked for those dates' });
    next(err);
  }
}

// action: confirm | decline | cancel (refund: boolean) | end (departure);
// without action, edits contact/boat/notes fields.
async function updateBooking(req, res, next) {
  try {
    const b = await bookingOr404(req, res);
    if (!b) return;
    const { action } = req.body || {};
    let r;
    if (action === 'confirm') r = await life.confirmBooking(b.id);
    else if (action === 'decline') r = await life.declineBooking(b.id, { reason: req.body.reason });
    else if (action === 'cancel') r = await life.cancelBooking(b.id, { by: 'staff', refund: req.body.refund === true, reason: req.body.reason ?? 'cancelled by marina' });
    else if (action === 'end') {
      if (!isValidDate(req.body.departure)) return res.status(400).json({ error: 'departure must be YYYY-MM-DD' });
      r = await life.endBooking(b.id, req.body.departure);
    } else if (action === undefined) {
      const EDITABLE = ['contact_name', 'contact_email', 'contact_phone', 'boat_name', 'boat_length_m', 'boat_beam_m', 'notes'];
      const fields = Object.fromEntries(EDITABLE.filter((k) => req.body[k] !== undefined).map((k) => [k, req.body[k] === '' ? null : req.body[k]]));
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
      if ('contact_name' in fields && !fields.contact_name) return res.status(400).json({ error: 'contact_name cannot be empty' });
      if ('contact_email' in fields) fields.contact_email_key = fields.contact_email ? emailKey(fields.contact_email) : null;
      r = await life.withLockedBooking(b.id, async (client) => ({ ok: true, booking: await life.setRow(client, b.id, fields) }));
    } else return res.status(400).json({ error: 'action must be confirm, decline, cancel or end' });
    if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.booking ? { booking: r.booking } : {}) });
    // Stripe refused (capture/refund): the booking is unchanged apart from
    // payment_error, which staff see on the row.
    if (r.paymentFailed) return res.status(502).json({ error: r.paymentFailed, booking: r.booking });
    if (r.expired) return res.status(409).json({ error: 'This request expired before it was confirmed', booking: r.booking });
    res.json(r.booking);
  } catch (err) {
    if (err.code === '23P01') return res.status(409).json({ error: 'That change overlaps another booking' });
    next(err);
  }
}

module.exports = { listBookings, getBooking, createBooking, updateBooking };
