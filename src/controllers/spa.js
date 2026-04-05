const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Treatments ────────────────────────────────────────────────────────────────

async function listTreatments(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM spa_treatment WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTreatment(req, res, next) {
  try {
    const { name, description, duration_mins, price } = req.body;
    if (!name || !duration_mins || !price) return res.status(400).json({ error: 'name, duration_mins, and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO spa_treatment (name, description, duration_mins, price) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, description ?? null, duration_mins, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTreatment(req, res, next) {
  try {
    const { name, description, duration_mins, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_treatment SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         duration_mins = COALESCE($3, duration_mins),
         price         = COALESCE($4, price),
         status        = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [name, description, duration_mins, price, status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Treatment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Therapists ────────────────────────────────────────────────────────────────

async function listTherapists(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT * FROM spa_therapist WHERE status = 'active' ORDER BY name");
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTherapist(req, res, next) {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa_therapist (name) VALUES ($1) RETURNING *`, [name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// ── Slots ─────────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { date, from, to, therapist_id, treatment_id } = req.query;
    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (from) { params.push(from); query += ` AND ss.slot_date >= $${params.length}`; }
    if (to) { params.push(to); query += ` AND ss.slot_date <= $${params.length}`; }
    if (therapist_id) { params.push(therapist_id); query += ` AND ss.therapist_id = $${params.length}`; }
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function bulkCreateSlots(req, res, next) {
  try {
    const { therapist_id, treatment_id, from, to, times } = req.body;
    if (!therapist_id || !treatment_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'therapist_id, treatment_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const created = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      const date = d.toISOString().slice(0, 10);
      for (const time of times) {
        const { rows } = await pool.query(
          `INSERT INTO spa_slot (therapist_id, treatment_id, slot_date, slot_time)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (therapist_id, slot_date, slot_time) DO NOTHING
           RETURNING *`,
          [therapist_id, treatment_id, date, time]
        );
        if (rows.length) created.push(rows[0]);
      }
      d.setDate(d.getDate() + 1);
    }
    res.status(201).json({ created: created.length, slots: created });
  } catch (err) { next(err); }
}

async function searchSlots(req, res, next) {
  try {
    const { date, treatment_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE ss.slot_date = $1
        AND ss.status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM spa_appointment sa
          WHERE sa.slot_id = ss.id AND sa.status != 'cancelled'
        )
    `;
    const params = [date];
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_time, st.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Appointments ──────────────────────────────────────────────────────────────

async function listAppointments(req, res, next) {
  try {
    const { date, status, guest_id } = req.query;
    let query = `
      SELECT sa.*, ss.slot_date, ss.slot_time,
             st.name AS therapist_name, tr.name AS treatment_name, tr.price
      FROM spa_appointment sa
      JOIN spa_slot ss ON ss.id = sa.slot_id
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE 1=1
    `;
    const params = [];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND sa.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND sa.guest_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createAppointment(req, res, next) {
  const { slot_id, guest_id, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!slot_id || !contact_name) return res.status(400).json({ error: 'slot_id and contact_name are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query('SELECT * FROM spa_slot WHERE id = $1', [slot_id]);
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slotRes.rows[0].status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is not available' }); }

    const conflictRes = await client.query(
      `SELECT id FROM spa_appointment WHERE slot_id = $1 AND status != 'cancelled'`, [slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot already booked' }); }

    const { rows } = await client.query(
      `INSERT INTO spa_appointment (slot_id, guest_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [slot_id, guest_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null]
    );

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

async function updateAppointment(req, res, next) {
  try {
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_appointment SET
         status = COALESCE($1, status),
         notes  = COALESCE($2, notes)
       WHERE id = $3 RETURNING *`,
      [status, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listTreatments, createTreatment, updateTreatment,
  listTherapists, createTherapist,
  listSlots, bulkCreateSlots, searchSlots,
  listAppointments, createAppointment, updateAppointment,
};
