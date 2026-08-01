const pool = require('../db');
const { isValidDate } = require('../middleware/validate');

// ── Spas ──────────────────────────────────────────────────────────────────────

async function listSpas(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa ORDER BY name');
    res.json(rows);
  } catch (err) { next(err); }
}

async function getSpa(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM spa WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createSpa(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa (name, description, phone) VALUES ($1, $2, $3) RETURNING *`,
      [name, description ?? null, phone ?? null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateSpa(req, res, next) {
  try {
    const { name, description, phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         phone       = COALESCE($3, phone)
       WHERE id = $4 RETURNING *`,
      [name, description, phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spa not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Treatments ────────────────────────────────────────────────────────────────

async function listTreatments(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_treatment WHERE spa_id = $1 AND status = 'active' ORDER BY name",
      [req.params.spa_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTreatment(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name, description, duration_mins, price } = req.body;
    if (!name || !duration_mins || !price) return res.status(400).json({ error: 'name, duration_mins, and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO spa_treatment (spa_id, name, description, duration_mins, price) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [spa_id, name, description ?? null, duration_mins, price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTreatment(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, description, duration_mins, price, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_treatment SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         duration_mins = COALESCE($3, duration_mins),
         price         = COALESCE($4, price),
         status        = COALESCE($5, status)
       WHERE id = $6 AND spa_id = $7 RETURNING *`,
      [name, description, duration_mins, price, status, id, spa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Treatment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Therapists ────────────────────────────────────────────────────────────────

async function listTherapists(req, res, next) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM spa_therapist WHERE spa_id = $1 AND status = 'active' ORDER BY name",
      [req.params.spa_id]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createTherapist(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO spa_therapist (spa_id, name) VALUES ($1, $2) RETURNING *`, [spa_id, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateTherapist(req, res, next) {
  try {
    const { spa_id, id } = req.params;
    const { name, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_therapist SET
         name   = COALESCE($1, name),
         status = COALESCE($2, status)
       WHERE id = $3 AND spa_id = $4 RETURNING *`,
      [name, status, id, spa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Therapist not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ── Slots ─────────────────────────────────────────────────────────────────────

async function listSlots(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, from, to, therapist_id, treatment_id } = req.query;
    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
    `;
    const params = [spa_id];
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
    const { spa_id } = req.params;
    const { therapist_id, treatment_id, from, to, times } = req.body;
    if (!therapist_id || !treatment_id || !from || !to || !Array.isArray(times) || !times.length) {
      return res.status(400).json({ error: 'therapist_id, treatment_id, from, to, and times array are required' });
    }
    if (!isValidDate(from) || !isValidDate(to)) return res.status(400).json({ error: 'Invalid date format' });

    const therapistRes = await pool.query('SELECT spa_id FROM spa_therapist WHERE id = $1', [therapist_id]);
    if (!therapistRes.rows.length || therapistRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'therapist_id does not belong to this spa' });
    }
    const treatmentRes = await pool.query('SELECT spa_id FROM spa_treatment WHERE id = $1', [treatment_id]);
    if (!treatmentRes.rows.length || treatmentRes.rows[0].spa_id !== spa_id) {
      return res.status(400).json({ error: 'treatment_id does not belong to this spa' });
    }

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
    const { spa_id } = req.params;
    const { date, treatment_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format' });

    let query = `
      SELECT ss.*, st.name AS therapist_name, tr.name AS treatment_name,
             tr.duration_mins, tr.price
      FROM spa_slot ss
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
        AND ss.slot_date = $2
        AND ss.status = 'available'
        AND NOT EXISTS (
          SELECT 1 FROM spa_appointment sa
          WHERE sa.slot_id = ss.id AND sa.status != 'cancelled'
        )
    `;
    const params = [spa_id, date];
    if (treatment_id) { params.push(treatment_id); query += ` AND ss.treatment_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_time, st.name';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

// ── Appointments ──────────────────────────────────────────────────────────────

async function listAppointments(req, res, next) {
  try {
    const { spa_id } = req.params;
    const { date, status, guest_id, clerk_user_id } = req.query;
    let query = `
      SELECT sa.*, ss.slot_date, ss.slot_time,
             st.name AS therapist_name, tr.name AS treatment_name, tr.price
      FROM spa_appointment sa
      JOIN spa_slot ss ON ss.id = sa.slot_id
      JOIN spa_therapist st ON st.id = ss.therapist_id
      JOIN spa_treatment tr ON tr.id = ss.treatment_id
      WHERE st.spa_id = $1
    `;
    const params = [spa_id];
    if (date) { params.push(date); query += ` AND ss.slot_date = $${params.length}`; }
    if (status) { params.push(status); query += ` AND sa.status = $${params.length}`; }
    if (guest_id) { params.push(guest_id); query += ` AND sa.guest_id = $${params.length}`; }
    if (clerk_user_id) { params.push(clerk_user_id); query += ` AND sa.clerk_user_id = $${params.length}`; }
    query += ' ORDER BY ss.slot_date, ss.slot_time';
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createAppointment(req, res, next) {
  const { spa_id } = req.params;
  const { slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!slot_id || !contact_name) return res.status(400).json({ error: 'slot_id and contact_name are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const slotRes = await client.query(
      `SELECT ss.* FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE ss.id = $1 AND st.spa_id = $2`,
      [slot_id, spa_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Slot not found' }); }
    if (slotRes.rows[0].status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot is not available' }); }

    const conflictRes = await client.query(
      `SELECT id FROM spa_appointment WHERE slot_id = $1 AND status != 'cancelled'`, [slot_id]
    );
    if (conflictRes.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Slot already booked' }); }

    const { rows } = await client.query(
      `INSERT INTO spa_appointment (slot_id, guest_id, clerk_user_id, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [slot_id, guest_id ?? null, clerk_user_id ?? null, contact_name, contact_email ?? null, contact_phone ?? null, notes ?? null]
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
    const { spa_id, id } = req.params;
    const { status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE spa_appointment sa SET
         status = COALESCE($1, sa.status),
         notes  = COALESCE($2, sa.notes)
       FROM spa_slot ss
       JOIN spa_therapist st ON st.id = ss.therapist_id
       WHERE sa.slot_id = ss.id
         AND sa.id = $3
         AND st.spa_id = $4
       RETURNING sa.*`,
      [status, notes, id, spa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {
  listSpas, getSpa, createSpa, updateSpa,
  listTreatments, createTreatment, updateTreatment,
  listTherapists, createTherapist, updateTherapist,
  listSlots, bulkCreateSlots, searchSlots,
  listAppointments, createAppointment, updateAppointment,
};
