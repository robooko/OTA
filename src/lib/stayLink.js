const pool = require('../db');

// The day each row happened, in the property's time zone.
const DAY = {
  restaurant_order: '(t2.created_at AT TIME ZONE p.timezone)::date',
  spa_appointment: 't2.appointment_date',
};

// Sets booking_id on rows (of `table`, in this property) that have a guest but
// no booking, to that guest's non-cancelled stay covering the row's day. The
// check-out day counts (breakfast / a treatment before leaving); on a
// turnover day the arriving stay wins; a no-show stay only when nothing else
// covers it. Returns Map(row id -> booking id) of the rows it set.
async function attachStays(table, propertyId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `UPDATE ${table} t SET booking_id = s.booking_id
       FROM (SELECT t2.id,
                    (SELECT b.id FROM booking b
                      WHERE b.property_id = t2.property_id AND b.guest_id = t2.guest_id AND b.status <> 'cancelled'
                        AND ${DAY[table]} BETWEEN b.check_in AND b.check_out
                      ORDER BY b.status = 'no_show', b.check_in DESC, b.id LIMIT 1) AS booking_id
               FROM ${table} t2 JOIN property p ON p.id = t2.property_id
              WHERE t2.id = ANY($2::uuid[]) AND t2.property_id = $1
                AND t2.guest_id IS NOT NULL AND t2.booking_id IS NULL) s
      WHERE t.id = s.id AND s.booking_id IS NOT NULL AND t.booking_id IS NULL
      RETURNING t.id, t.booking_id`,
    [propertyId, ids]
  );
  return new Map(rows.map((r) => [r.id, r.booking_id]));
}

module.exports = { attachStays };
