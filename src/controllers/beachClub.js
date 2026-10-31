const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

const BED_STATUSES = ['active', 'inactive'];
const BOOKING_STATUSES = ['confirmed', 'cancelled'];

// ── Beds ──────────────────────────────────────────────────────────────────────

async function listBeds(req, res, next) {
  try {
    const { zone } = req.query;
    let query = "SELECT * FROM beach_bed WHERE property_id = $1 AND status = 'active'";
    const params = [req.property_id];
    if (zone) { params.push(zone); query += ` AND zone = $${params.length}`; }
    query += ' ORDER BY bed_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createBed(req, res, next) {
  try {
    const { bed_number, zone } = req.body;
    if (!bed_number) return res.status(400).json({ error: 'bed_number is required' });
    const { rows } = await pool.query(
      `INSERT INTO beach_bed (property_id, bed_number, zone) VALUES ($1, $2, $3) RETURNING *`,
      [req.property_id, bed_number, zone ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A bed with that number already exists' });
    next(err);
  }
}

async function updateBed(req, res, next) {
  try {
    const { bed_number, zone, status } = req.body;
    if (status !== undefined && !BED_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${BED_STATUSES.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE beach_bed SET
         bed_number = COALESCE($1, bed_number),
         zone       = COALESCE($2, zone),
         status     = COALESCE($3, status)
       WHERE id = $4 AND property_id = $5 RETURNING *`,
      [bed_number, zone, status, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bed not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A bed with that number already exists' });
    next(err);
  }
}

// ── Search availability ───────────────────────────────────────────────────────

async function searchBeds(req, res, next) {
  try {
    const { date, zone } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT b.*
      FROM beach_bed b
      WHERE b.property_id = $1 AND b.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM beach_booking bb
          WHERE bb.bed_id = b.id AND bb.date = $2 AND bb.status != 'cancelled'
        )
    `;
    const params = [req.property_id, date];
    if (zone) { params.push(zone); query += ` AND b.zone = $${params.length}`; }
    query += ' ORDER BY b.bed_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Bookings ──────────────────────────────────────────────────────────────────

async function listBookings(req, res, next) {
  try {
    const { date, status, guest_id, zone } = req.query;
    let query = `
      SELECT bb.*, b.bed_number, b.zone
      FROM beach_booking bb
      JOIN beach_bed b ON b.id = bb.bed_id
      WHERE bb.property_id = $1
    `;
    const params = [req.property_id];
    if (date) { params.push(date); query += ` AND bb.date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND bb.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND bb.guest_id = $${params.length}`; }
    if (zone) { params.push(zone); query += ` AND b.zone = $${params.length}`; }
    query += ' ORDER BY bb.date, b.bed_number';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createBooking(req, res, next) {
  const { bed_id, guest_id, contact_name, contact_email, contact_phone, date, notes } = req.body;
  if (!bed_id || !contact_name || !date) return res.status(400).json({ error: 'bed_id, contact_name, and date are required' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bedRes = await client.query('SELECT * FROM beach_bed WHERE id = $1 AND property_id = $2', [bed_id, req.property_id]);
    if (!bedRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bed not found' }); }
    if (bedRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Bed is not active' }); }

    if (guest_id) {
      const g = await client.query('SELECT 1 FROM guest WHERE id = $1 AND property_id = $2', [guest_id, req.property_id]);
      if (!g.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Guest not found' }); }
    }

    const { rows } = await client.query(
      `INSERT INTO beach_booking (property_id, bed_id, guest_id, contact_name, contact_email, contact_phone, date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.property_id, bed_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, date, notes ?? null]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    // beach_booking_bed_date_live: a live booking already holds the bed.
    if (err.code === '23505') return res.status(409).json({ error: 'Bed already booked for this date' });
    next(err);
  } finally {
    client.release();
  }
}

async function updateBooking(req, res, next) {
  try {
    const { status, notes } = req.body;
    if (status !== undefined && !BOOKING_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${BOOKING_STATUSES.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE beach_booking SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 AND property_id = $4 RETURNING *`,
      [status, notes, req.params.id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) {
    // Un-cancelling onto a bed someone else has since booked.
    if (err.code === '23505') return res.status(409).json({ error: 'Bed already booked for this date' });
    next(err);
  }
}

module.exports = {
  listBeds, createBed, updateBed,
  searchBeds,
  listBookings, createBooking, updateBooking,
};
