const pool = require('../db');

async function listGuests(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM guest ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getGuest(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT * FROM guest WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createGuest(req, res, next) {
  try {
    const { first_name, last_name, email, phone, clerk_user_id } = req.body;
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'first_name, last_name, and email are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO guest (clerk_user_id, first_name, last_name, email, phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [clerk_user_id || null, first_name, last_name, email, phone || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
}

// Smart lookup for Clerk-authenticated users:
// 1. Match by clerk_user_id (fastest, works after first link)
// 2. Fall back to email match and link the clerk_user_id
// 3. Return 404 if neither found
async function lookupGuest(req, res, next) {
  try {
    const { clerk_user_id, email } = req.query;

    if (!clerk_user_id && !email) {
      return res.status(400).json({ error: 'clerk_user_id or email is required' });
    }

    // 1. Try clerk_user_id first
    if (clerk_user_id) {
      const { rows } = await pool.query(
        'SELECT * FROM guest WHERE clerk_user_id = $1',
        [clerk_user_id]
      );
      if (rows.length) return res.json(rows[0]);
    }

    // 2. Fall back to email, then link clerk_user_id
    if (email) {
      const { rows } = await pool.query(
        'SELECT * FROM guest WHERE email = $1',
        [email]
      );
      if (!rows.length) return res.status(404).json({ error: 'Guest not found' });

      // Link clerk_user_id if provided and not yet set
      if (clerk_user_id && !rows[0].clerk_user_id) {
        const { rows: updated } = await pool.query(
          'UPDATE guest SET clerk_user_id = $1 WHERE id = $2 RETURNING *',
          [clerk_user_id, rows[0].id]
        );
        return res.json(updated[0]);
      }

      return res.json(rows[0]);
    }

    return res.status(404).json({ error: 'Guest not found' });
  } catch (err) {
    next(err);
  }
}

async function updateGuest(req, res, next) {
  try {
    const { first_name, last_name, email, phone, clerk_user_id } = req.body;
    const { rows } = await pool.query(
      `UPDATE guest SET
         clerk_user_id = COALESCE($1, clerk_user_id),
         first_name    = COALESCE($2, first_name),
         last_name     = COALESCE($3, last_name),
         email         = COALESCE($4, email),
         phone         = COALESCE($5, phone)
       WHERE id = $6 RETURNING *`,
      [clerk_user_id, first_name, last_name, email, phone, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    next(err);
  }
}

async function getGuestSummary(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(DISTINCT b.id)                                       AS total_stays,
         COALESCE(SUM(b.total_price), 0)                            AS total_spent,
         COALESCE(AVG(b.check_out - b.check_in), 0)                 AS avg_nights,
         COALESCE(SUM(b.check_out - b.check_in), 0)                 AS total_nights,
         MAX(b.check_in)                                            AS last_stay,
         COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'confirmed') AS confirmed,
         COUNT(DISTINCT b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled,
         COALESCE(SUM(be.quantity * be.unit_price), 0)              AS total_extras_spent,
         COUNT(DISTINCT be.id)                                      AS total_extras
       FROM booking b
       LEFT JOIN booking_extra be ON be.booking_id = b.id
       WHERE b.guest_id = $1`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function deleteGuest(req, res, next) {
  try {
    const { rows } = await pool.query('DELETE FROM guest WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Guest not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { listGuests, getGuest, lookupGuest, getGuestSummary, createGuest, updateGuest, deleteGuest };
