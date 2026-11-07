const pool = require('../db');
const { validatePlan, sameTerms } = require('../lib/ratePlans');

// Rate plans (Saver/Flex) per room type -- see
// docs/superpowers/specs/2026-10-30-room-rate-plans-design.md. No delete:
// bookings reference plans, so they are archived instead. Edits only affect
// new bookings (bookings keep a snapshot of the terms).

const FIELDS = ['name', 'adjustment_pct', 'refundable', 'cancel_cutoff_hours', 'payment_mode', 'deposit_kind', 'deposit_value', 'sort_order', 'status'];

const DEFAULTS = {
  adjustment_pct: 0, cancel_cutoff_hours: null, deposit_kind: null, deposit_value: null, sort_order: 0, status: 'active',
};

async function roomTypeExists(id, propertyId) {
  const { rows } = await pool.query('SELECT 1 FROM room_type WHERE id = $1 AND property_id = $2', [id, propertyId]);
  return rows.length > 0;
}

// Same name = same terms (multi-room spec): a booking has one rate, so its
// rooms' plans must pay and cancel alike. Returns a 409 body or null.
async function nameClash(propertyId, plan, selfId = null) {
  if (plan.status !== 'active') return null;
  const { rows } = await pool.query(
    `SELECT * FROM rate_plan
     WHERE property_id = $1 AND status = 'active' AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)`,
    [propertyId, plan.name, selfId]
  );
  if (rows.every((r) => sameTerms(r, plan))) return null;
  return {
    error: `A rate plan named "${plan.name}" already exists with different payment or cancellation terms`,
    details: 'Plans with the same name must share payment_mode, refundable, cancel_cutoff_hours and deposit',
  };
}

function pick(body) {
  const out = {};
  for (const k of FIELDS) if (body?.[k] !== undefined) out[k] = typeof body[k] === 'string' && k === 'name' ? body[k].trim() : body[k];
  return out;
}

async function listRatePlans(req, res, next) {
  try {
    if (!(await roomTypeExists(req.params.id, req.property_id))) return res.status(404).json({ error: 'Room type not found' });
    const activeOnly = req.auth_method === 'api_key';
    const { rows } = await pool.query(
      `SELECT * FROM rate_plan WHERE room_type_id = $1 AND property_id = $2 ${activeOnly ? "AND status = 'active'" : ''}
       ORDER BY sort_order, name`,
      [req.params.id, req.property_id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createRatePlan(req, res, next) {
  try {
    if (!(await roomTypeExists(req.params.id, req.property_id))) return res.status(404).json({ error: 'Room type not found' });
    const plan = { ...DEFAULTS, ...pick(req.body) };
    const error = validatePlan(plan);
    if (error) return res.status(400).json({ error });
    const clash = await nameClash(req.property_id, plan);
    if (clash) return res.status(409).json(clash);
    const { rows } = await pool.query(
      `INSERT INTO rate_plan (property_id, room_type_id, ${FIELDS.join(', ')})
       VALUES ($1, $2, ${FIELDS.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
      [req.property_id, req.params.id, ...FIELDS.map((k) => plan[k])]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// Partial update: the body is merged over the stored plan, then the whole
// plan is validated (so switching to deposit needs the deposit fields too).
async function updateRatePlan(req, res, next) {
  try {
    const { rows: [current] } = await pool.query(
      'SELECT * FROM rate_plan WHERE id = $1 AND room_type_id = $2 AND property_id = $3',
      [req.params.plan_id, req.params.id, req.property_id]
    );
    if (!current) return res.status(404).json({ error: 'Rate plan not found' });
    const plan = { ...current, ...pick(req.body) };
    plan.adjustment_pct = Number(plan.adjustment_pct);
    if (plan.deposit_value != null) plan.deposit_value = Number(plan.deposit_value);
    const error = validatePlan(plan);
    if (error) return res.status(400).json({ error });
    const clash = await nameClash(req.property_id, plan, current.id);
    if (clash) return res.status(409).json(clash);
    const { rows } = await pool.query(
      `UPDATE rate_plan SET ${FIELDS.map((k, i) => `${k} = $${i + 2}`).join(', ')}
       WHERE id = $1 RETURNING *`,
      [current.id, ...FIELDS.map((k) => plan[k])]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { listRatePlans, createRatePlan, updateRatePlan };
