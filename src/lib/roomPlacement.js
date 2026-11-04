// Picking a room for a stay: shared by createBooking (direct) and channel
// reservations, so both follow the same availability rules.

// Nights of a stay, [check_in, check_out).
function stayNights(checkIn, checkOut) {
  const nights = [];
  const d = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);
  while (d < end) {
    nights.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return nights;
}

// Tries candidates in order inside the caller's transaction: a room needs an
// open room_availability row for every night. insert(candidate, availMap)
// writes the booking row (availMap[date] = { is_available, override_rate });
// a 23P01 from the overlap constraint means someone else got it, so the next
// candidate is tried. On success the booked room's nights are closed.
async function placeBooking(client, { candidates, nights, insert }) {
  let lastUnavailableDate = null;
  for (const candidate of candidates) {
    await client.query('SAVEPOINT attempt');
    const { rows } = await client.query(
      `SELECT date, is_available, override_rate FROM room_availability
       WHERE room_id = $1 AND date = ANY($2::date[])`,
      [candidate.id, nights]
    );
    const availMap = {};
    for (const row of rows) availMap[row.date] = row;
    const closed = nights.find((date) => !availMap[date]?.is_available);
    if (closed) {
      lastUnavailableDate = closed;
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      continue;
    }
    let booked;
    try {
      booked = await insert(candidate, availMap);
    } catch (err) {
      if (err.code === '23P01') {
        await client.query('ROLLBACK TO SAVEPOINT attempt');
        continue;
      }
      throw err;
    }
    await client.query('RELEASE SAVEPOINT attempt');
    await client.query(
      'UPDATE room_availability SET is_available = false WHERE room_id = $1 AND date = ANY($2::date[])',
      [booked.room_id, nights]
    );
    return { booked, lastUnavailableDate };
  }
  return { booked: null, lastUnavailableDate };
}

module.exports = { stayNights, placeBooking };
