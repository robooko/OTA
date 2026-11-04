// What a channel should be showing right now, from live tables: one row per
// mapping per date in [today, today + horizon_days). See the channel
// distribution spec §1.
//   available = free nights of ACTIVE rooms of the type (not the
//               room_type_availability view, which counts inactive rooms too),
//               capped by the smallest matching trim, 0 under stop-sell
//   rate      = room_type_rate else base_rate, plus the mapping's plan
//               adjustment; per-room override_rate is never advertised
// A closing mapping, or a pausing channel, is closed out: 0 + stop-sell.
const { applyAdjustment } = require('../ratePlans');

async function desiredAri(db, channel) {
  const p = [channel.property_id, channel.horizon_days];
  const range = `ra.date >= CURRENT_DATE AND ra.date < CURRENT_DATE + $2::int`;
  const [{ rows: mappings }, { rows: dates }, { rows: free }, { rows: rates }, { rows: trims }] = await Promise.all([
    db.query(
      `SELECT m.id, m.room_type_id, m.room_code, m.rate_code, m.status, rt.base_rate, rp.adjustment_pct
       FROM channel_mapping m
       JOIN room_type rt ON rt.id = m.room_type_id
       LEFT JOIN rate_plan rp ON rp.id = m.rate_plan_id
       WHERE m.channel_id = $1 ORDER BY m.room_code, m.rate_code`, [channel.id]),
    db.query(`SELECT (CURRENT_DATE + i)::text AS date FROM generate_series(0, $1::int - 1) i`, [channel.horizon_days]),
    db.query(
      `SELECT r.room_type_id, ra.date, COUNT(*)::int AS n
       FROM room r JOIN room_availability ra ON ra.room_id = r.id
       WHERE r.property_id = $1 AND r.status = 'active' AND ra.is_available AND ${range}
       GROUP BY r.room_type_id, ra.date`, p),
    db.query(
      `SELECT room_type_id, date, rate FROM room_type_rate ra
       WHERE property_id = $1 AND ${range}`, p),
    db.query(
      `SELECT room_type_id, date_from, date_to, max_available, stop_sell FROM channel_trim
       WHERE channel_id = $1 AND date_to >= CURRENT_DATE`, [channel.id]),
  ]);

  const freeOf = new Map(free.map((f) => [`${f.room_type_id}|${f.date}`, f.n]));
  const rateOf = new Map(rates.map((r) => [`${r.room_type_id}|${r.date}`, r.rate]));
  const closedOut = channel.status === 'pausing';

  const rows = [];
  for (const m of mappings) {
    for (const { date } of dates) {
      const night = rateOf.get(`${m.room_type_id}|${date}`) ?? m.base_rate;
      const rate = m.adjustment_pct == null ? Number(night) : applyAdjustment(night, m.adjustment_pct);
      let available = freeOf.get(`${m.room_type_id}|${date}`) ?? 0;
      let stop_sell = false;
      for (const t of trims) {
        if ((t.room_type_id && t.room_type_id !== m.room_type_id) || date < t.date_from || date > t.date_to) continue;
        if (t.max_available != null) available = Math.min(available, t.max_available);
        if (t.stop_sell) stop_sell = true;
      }
      if (closedOut || m.status === 'closing') stop_sell = true;
      if (stop_sell) available = 0;
      rows.push({ mapping_id: m.id, room_code: m.room_code, rate_code: m.rate_code, date, available, rate, stop_sell });
    }
  }
  return rows;
}

module.exports = { desiredAri };
