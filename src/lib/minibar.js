// Minibar lists and usage -- see docs/superpowers/specs/2026-10-31-housekeeping-design.md.
// A room type has a list; a rate plan may have its own, which replaces the
// room type's entirely. Included items are never charged, at any quantity.

const LIST_SQL = `
  SELECT li.minibar_item_id, m.name, m.description, m.image_url, m.price, li.quantity, li.included
  FROM minibar_list_item li
  JOIN minibar_item m ON m.id = li.minibar_item_id AND m.status = 'active'
  WHERE li.room_type_id = $1 AND li.rate_plan_id IS NOT DISTINCT FROM $2
  ORDER BY m.name`;

async function resolveList(db, roomTypeId, ratePlanId) {
  if (ratePlanId) {
    const { rows } = await db.query(LIST_SQL, [roomTypeId, ratePlanId]);
    if (rows.length) return rows;
  }
  return (await db.query(LIST_SQL, [roomTypeId, null])).rows;
}

// Sets a job's minibar usage (replacing any earlier recording, so an app
// retry never charges twice). Returns { error } on bad input, else the rows.
async function recordUsage(db, { propertyId, job, items, userId }) {
  if (!Array.isArray(items)) return { error: 'items must be an array' };
  for (const i of items) {
    if (!Number.isInteger(i?.quantity) || i.quantity < 0 || i.quantity > 99) return { error: 'quantity must be a whole number 0 to 99' };
  }
  const booking = (await db.query(
    `SELECT b.id, b.rate_plan_id, r.room_type_id FROM booking b JOIN room r ON r.id = b.room_id WHERE b.id = $1`, [job.booking_id]
  )).rows[0];
  const ids = items.map((i) => i.minibar_item_id);
  const catalogue = new Map((await db.query(
    `SELECT id, name, price FROM minibar_item WHERE property_id = $1 AND id::text = ANY($2::text[])`, [propertyId, ids.map(String)]
  )).rows.map((m) => [m.id, m]));
  const unknown = ids.find((id) => !catalogue.has(id));
  if (unknown !== undefined) return { error: `Unknown minibar item ${unknown}` };
  const included = new Set((await resolveList(db, booking.room_type_id, booking.rate_plan_id)).filter((i) => i.included).map((i) => i.minibar_item_id));

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialises overlapping recordings of one job (an app retry while the
    // first is still running) so the replace can't double the charge.
    await client.query('SELECT 1 FROM hk_job WHERE id = $1 FOR UPDATE', [job.id]);
    await client.query('DELETE FROM minibar_usage WHERE job_id = $1', [job.id]);
    const rows = [];
    for (const i of items.filter((x) => x.quantity > 0)) {
      const m = catalogue.get(i.minibar_item_id);
      rows.push((await client.query(
        `INSERT INTO minibar_usage (booking_id, job_id, minibar_item_id, item_name, quantity, unit_price, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [booking.id, job.id, m.id, m.name, i.quantity, included.has(m.id) ? 0 : m.price, userId ?? null]
      )).rows[0]);
    }
    await client.query('COMMIT');
    return { rows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { resolveList, recordUsage };
