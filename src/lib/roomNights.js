// Room nights: who holds which room on which night (booking_night), and how
// many of each room type are still sellable. The single writer of
// booking_night. See docs/superpowers/specs/2026-11-05-room-overbooking-design.md.
//
// sellable(type, night) = active rooms - staff-blocked rooms - nights sold as
// the type (placed or not) + effective oversell allowance, never below 0.
// A closed room_availability flag is a staff block only when no booking holds
// that room that night: holds still close flags so old readers stay right.

const HOLDING = ['pending_payment', 'confirmed', 'checked_in'];

// One row per type x night. typeId null = every type of the property.
const COUNTS_SQL = `
  WITH n AS (SELECT DISTINCT unnest($3::date[]) AS night),
  t AS (SELECT id FROM room_type WHERE property_id = $1 AND ($2::uuid IS NULL OR id = $2)),
  p AS (SELECT overbooking_enabled, oversell_max_pct FROM property WHERE id = $1),
  rooms AS (SELECT room_type_id, count(*)::int AS n FROM room
            WHERE property_id = $1 AND status = 'active' GROUP BY room_type_id),
  blk AS (SELECT r.room_type_id, ra.date AS night, count(*)::int AS n
          FROM room_availability ra JOIN room r ON r.id = ra.room_id
          WHERE r.property_id = $1 AND r.status = 'active' AND NOT ra.is_available AND ra.date = ANY($3::date[])
            AND NOT EXISTS (SELECT 1 FROM booking_night h WHERE h.room_id = ra.room_id AND h.night = ra.date)
          GROUP BY r.room_type_id, ra.date),
  sold AS (SELECT b.room_type_id, bn.night, count(*)::int AS n,
                  (count(*) FILTER (WHERE bn.room_id IS NULL))::int AS unplaced
           FROM booking_night bn JOIN booking b ON b.id = bn.booking_id
           WHERE bn.property_id = $1 AND bn.night = ANY($3::date[])
           GROUP BY b.room_type_id, bn.night)
  SELECT t.id AS room_type_id, n.night::text AS night,
         COALESCE(rooms.n, 0) AS rooms, COALESCE(blk.n, 0) AS blocked,
         COALESCE(sold.n, 0) AS sold, COALESCE(sold.unplaced, 0) AS unplaced,
         COALESCE(o.model_allowance, 0) AS model, o.manual_allowance AS manual,
         floor(p.oversell_max_pct / 100 * COALESCE(rooms.n, 0))::int AS cap,
         p.overbooking_enabled AS enabled
  FROM t CROSS JOIN n CROSS JOIN p
  LEFT JOIN rooms ON rooms.room_type_id = t.id
  LEFT JOIN blk  ON blk.room_type_id = t.id AND blk.night = n.night
  LEFT JOIN sold ON sold.room_type_id = t.id AND sold.night = n.night
  LEFT JOIN room_type_oversell o ON o.room_type_id = t.id AND o.date = n.night`;

// Map "typeId|night" -> { rooms, blocked, sold, unplaced, model, manual, cap, allowance, sellable }.
async function typeCounts(db, propertyId, roomTypeId, nights) {
  const { rows } = await db.query(COUNTS_SQL, [propertyId, roomTypeId ?? null, nights]);
  const out = new Map();
  for (const r of rows) {
    const allowance = r.enabled ? Math.min(r.manual ?? r.model, r.cap) : 0;
    const sellable = Math.max(0, r.rooms - r.blocked - r.sold + allowance);
    out.set(`${r.room_type_id}|${r.night}`, {
      room_type_id: r.room_type_id, night: r.night, rooms: r.rooms, blocked: r.blocked, sold: r.sold,
      unplaced: r.unplaced, model: r.model, manual: r.manual, cap: r.cap, allowance, sellable,
    });
  }
  return out;
}

module.exports = { HOLDING, typeCounts };
