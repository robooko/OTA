const pool = require('../db');
const { toCents, fromCents } = require('./folio');

// The folio of a booking that isn't a room stay -- a golf booking, an
// equipment hire, a restaurant reservation -- in the same shape as
// computeFolio (lib/folio.js): computed live, never stored. Charges are the
// booking's own price (dropped once it is cancelled, so anything taken shows
// as a credit), golf's pro-shop items, and staff adjustments; payments are
// rows owned through the matching payment.<kind>_id column. See
// docs/superpowers/specs/2026-11-12-entity-charges-design.md.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
const times = (name, quantity) => (quantity > 1 ? `${name} × ${quantity}` : name);

// Per kind: the row (status, currency, external_payment and what the base
// line needs), the base line, and any extra lines of its own.
const KINDS = {
  golf_booking: {
    row: `SELECT gb.id, gb.status, gb.total_price, gb.players, gc.name AS course_name,
                 p.currency, false AS external_payment
          FROM golf_booking gb
          JOIN tee_time tt   ON tt.id = gb.tee_time_id
          JOIN golf_course gc ON gc.id = tt.course_id
          JOIN property p    ON p.id = gb.property_id
          WHERE gb.id = $1 AND gb.property_id = $2`,
    base: (r) => ({ description: `${r.course_name} · ${plural(r.players, 'player')}`, amount: r.total_price }),
    async lines(id) {
      const { rows } = await pool.query(
        'SELECT id, item_name, quantity, unit_price FROM golf_booking_item WHERE booking_id = $1 ORDER BY item_name, id',
        [id]
      );
      return rows.map((i) => ({
        type: 'item',
        source_id: i.id,
        description: times(i.item_name, i.quantity),
        amount: fromCents(toCents(i.unit_price) * i.quantity),
      }));
    },
  },
  equipment_hire: {
    row: `SELECT eh.id, eh.status, COALESCE(eh.total_price, 0) AS total_price, eh.quantity, e.name AS equipment_name,
                 p.currency, false AS external_payment
          FROM equipment_hire eh
          JOIN equipment e ON e.id = eh.equipment_id
          JOIN property p  ON p.id = eh.property_id
          WHERE eh.id = $1 AND eh.property_id = $2`,
    base: (r) => ({ description: times(r.equipment_name, r.quantity), amount: fromCents(toCents(r.total_price)) }),
  },
  restaurant_reservation: {
    // No base line: a table has no price. A deposit taken the existing way
    // lives only on Stripe (stripe_payment_intent_id), so it is flagged,
    // never totalled.
    row: `SELECT rr.id, rr.status, COALESCE(r.currency, p.currency) AS currency,
                 (rr.stripe_payment_intent_id IS NOT NULL) AS external_payment
          FROM restaurant_reservation rr
          JOIN restaurant_table rt ON rt.id = rr.table_id
          JOIN restaurant r        ON r.id = rt.restaurant_id
          JOIN property p          ON p.id = rr.property_id
          WHERE rr.id = $1 AND rr.property_id = $2`,
  },
};

const ENTITY_KINDS = Object.keys(KINDS);

// The payment / folio_adjustment column owning a kind's rows. Only ever
// built from this whitelist, since callers interpolate it into SQL.
function ownerColumn(kind) {
  return Object.hasOwn(KINDS, kind) ? `${kind}_id` : null;
}

// The entity's row, or null for an unknown kind, a malformed id, or an id in
// another property -- callers 404 on all three.
async function findEntity(kind, id, propertyId) {
  if (!Object.hasOwn(KINDS, kind) || typeof id !== 'string' || !UUID_RE.test(id)) return null;
  const { rows } = await pool.query(KINDS[kind].row, [id, propertyId]);
  return rows[0] ?? null;
}

async function computeEntityFolio(kind, id, propertyId) {
  const entity = await findEntity(kind, id, propertyId);
  if (!entity) return null;
  const config = KINDS[kind];
  const column = ownerColumn(kind);

  const [own, adjustmentsRes, paymentsRes] = await Promise.all([
    config.lines ? config.lines(id) : [],
    pool.query(
      `SELECT id, description, amount, created_at FROM folio_adjustment
       WHERE ${column} = $1 AND property_id = $2 ORDER BY created_at, id`,
      [id, propertyId]
    ),
    pool.query(
      `SELECT * FROM payment WHERE ${column} = $1 AND property_id = $2
       ORDER BY paid_at DESC NULLS LAST, id`,
      [id, propertyId]
    ),
  ]);

  const items = [
    ...(config.base && entity.status !== 'cancelled' ? [{ type: 'base', ...config.base(entity) }] : []),
    ...own,
    ...adjustmentsRes.rows.map((a) => ({
      type: 'adjustment',
      source_id: a.id,
      description: a.description,
      amount: a.amount,
      created_at: a.created_at,
    })),
  ];

  const chargesCents = items.reduce((sum, i) => sum + toCents(i.amount), 0);
  const paymentsCents = paymentsRes.rows
    .filter((p) => p.status === 'completed')
    .reduce((sum, p) => sum + toCents(p.amount), 0);

  return {
    kind,
    id,
    status: entity.status,
    currency: entity.currency,
    items,
    charges_total: fromCents(chargesCents),
    payments: paymentsRes.rows,
    payments_total: fromCents(paymentsCents),
    balance: fromCents(chargesCents - paymentsCents),
    external_payment: entity.external_payment,
  };
}

module.exports = { ENTITY_KINDS, ownerColumn, findEntity, computeEntityFolio };
