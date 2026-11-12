const pool = require('../db');
const { computeEntityFolio, findEntity, ownerColumn } = require('../lib/entityFolio');
const { syncSpaPaymentStatus } = require('../lib/spaLedger');

// /api/folios/:kind/:id -- the folio of a golf booking, equipment hire,
// restaurant reservation or spa appointment (lib/entityFolio.js), with the
// same manual charge and desk-payment actions a room folio has
// (controllers/folio.js, controllers/payments.js). Unknown kind, bad id and
// another property's id are all a plain 404. A spa appointment linked to a
// stay is charged on that room's folio, so it takes neither here (409); after
// any change to a spa appointment its payment_status is re-derived.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (res) => res.status(404).json({ error: 'Not found' });
const onRoomFolio = (res, entity) => res.status(409).json({ error: 'Charged to the room booking -- use its folio', booking_id: entity.charged_to_booking_id });
const afterChange = (kind, id, propertyId) => (kind === 'spa_appointment' ? syncSpaPaymentStatus(pool, id, propertyId) : null);

async function getEntityFolio(req, res, next) {
  try {
    const folio = await computeEntityFolio(req.params.kind, req.params.id, req.property_id);
    if (!folio) return notFound(res);
    res.json(folio);
  } catch (err) {
    next(err);
  }
}

async function addEntityAdjustment(req, res, next) {
  try {
    const { kind, id } = req.params;
    const entity = await findEntity(kind, id, req.property_id);
    if (!entity) return notFound(res);
    if (entity.charged_to_booking_id) return onRoomFolio(res, entity);
    const { description, amount } = req.body ?? {};
    const amt = Number(amount);
    if (!description || typeof description !== 'string' || amount == null || !Number.isFinite(amt) || amt === 0) {
      return res.status(400).json({ error: 'description and a non-zero amount are required' });
    }
    if (description.length > 200) {
      return res.status(400).json({ error: 'description must be 200 characters or fewer' });
    }
    const { rows } = await pool.query(
      `INSERT INTO folio_adjustment (property_id, ${ownerColumn(kind)}, description, amount)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.property_id, id, description, amt.toFixed(2)]
    );
    await afterChange(kind, id, req.property_id);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function removeEntityAdjustment(req, res, next) {
  try {
    const { kind, id, adjustment_id } = req.params;
    const column = ownerColumn(kind);
    if (!column || !UUID_RE.test(id ?? '') || !UUID_RE.test(adjustment_id ?? '')) {
      return res.status(404).json({ error: 'Adjustment not found on this booking' });
    }
    const { rows } = await pool.query(
      `DELETE FROM folio_adjustment WHERE id = $1 AND ${column} = $2 AND property_id = $3 RETURNING id`,
      [adjustment_id, id, req.property_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Adjustment not found on this booking' });
    await afterChange(kind, id, req.property_id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// A payment taken at the desk (cash, card terminal...). Always completed,
// never capped at the balance and allowed on a cancelled booking: a deposit
// or a refund-in-waiting is a real credit.
async function recordEntityPayment(req, res, next) {
  try {
    const { kind, id } = req.params;
    const entity = await findEntity(kind, id, req.property_id);
    if (!entity) return notFound(res);
    if (entity.charged_to_booking_id) return onRoomFolio(res, entity);
    const { amount, method } = req.body ?? {};
    const amt = Number(amount);
    if (amount == null || !Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    const { rows } = await pool.query(
      `INSERT INTO payment (property_id, ${ownerColumn(kind)}, amount, method, status, paid_at)
       VALUES ($1, $2, $3, $4, 'completed', now()) RETURNING *`,
      [req.property_id, id, amt.toFixed(2), typeof method === 'string' && method ? method.slice(0, 30) : null]
    );
    await afterChange(kind, id, req.property_id);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

module.exports = { getEntityFolio, addEntityAdjustment, removeEntityAdjustment, recordEntityPayment };
