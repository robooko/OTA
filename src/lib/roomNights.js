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

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

// Serialises sells of one room type (inside the caller's transaction), so two
// bookings can't both take the last sellable slot.
async function lockType(client, roomTypeId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('rt:' || $1::text))`, [roomTypeId]);
}

async function propertyToday(db, propertyId) {
  return (await db.query(
    `SELECT (now() AT TIME ZONE COALESCE(timezone, 'UTC'))::date::text AS today FROM property WHERE id = $1`, [propertyId])).rows[0].today;
}

async function logMove(client, m) {
  await client.query(
    `INSERT INTO booking_room_move (property_id, booking_id, night_from, night_to, from_room_id, to_room_id, reason, moved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [m.propertyId, m.bookingId, m.from, m.to, m.fromRoomId ?? null, m.toRoomId ?? null, m.reason, m.movedBy ?? null]);
}

// Open room_availability flags = the room is free on those nights (holds
// close them; a missing row = beyond the seeded horizon = not sellable).
// Reopening never lifts a staff block (block_reason set) that sat under a hold.
const setFlags = (client, roomId, nights, open) => client.query(
  `UPDATE room_availability SET is_available = $3
   WHERE room_id = $1 AND date = ANY($2::date[]) AND (NOT $3 OR block_reason IS NULL)`, [roomId, nights, open]);

// First active room of the type (by room_number) free on every night, or null.
async function freeRoom(client, propertyId, roomTypeId, nights, exceptRoomId = null) {
  const { rows } = await client.query(
    `SELECT r.id FROM room r
     WHERE r.property_id = $1 AND r.room_type_id = $2 AND r.status = 'active' AND r.id IS DISTINCT FROM $4
       AND (SELECT count(*) FROM room_availability ra
            WHERE ra.room_id = r.id AND ra.date = ANY($3::date[]) AND ra.is_available
              AND NOT EXISTS (SELECT 1 FROM booking_night h WHERE h.room_id = r.id AND h.night = ra.date)) = cardinality($3::date[])
     ORDER BY r.room_number LIMIT 1`,
    [propertyId, roomTypeId, nights, exceptRoomId]);
  return rows[0]?.id ?? null;
}

// Put the given nights of a booking into roomId (null = no room), closing /
// reopening flags. Rows must already exist (holdStay inserts them).
async function setNights(client, bookingId, nights, roomId) {
  const { rows: before } = await client.query(
    `SELECT night::text, room_id FROM booking_night WHERE booking_id = $1 AND night = ANY($2::date[])`, [bookingId, nights]);
  const vacated = new Map();
  for (const b of before) if (b.room_id && b.room_id !== roomId) (vacated.get(b.room_id) ?? vacated.set(b.room_id, []).get(b.room_id)).push(b.night);
  await client.query(`UPDATE booking_night SET room_id = $3 WHERE booking_id = $1 AND night = ANY($2::date[])`, [bookingId, nights, roomId]);
  for (const [room, ns] of vacated) await setFlags(client, room, ns, true);
  if (roomId) await setFlags(client, roomId, nights, false);
  return vacated;
}

// booking.room_id = tonight's room once the stay has started, else the first
// night's (null when that night has no room).
async function syncCurrentRoom(client, bookingId) {
  await client.query(
    `UPDATE booking b SET room_id = (
       SELECT bn.room_id FROM booking_night bn
       WHERE bn.booking_id = b.id
       ORDER BY (bn.night < GREATEST(b.check_in, (now() AT TIME ZONE COALESCE(p.timezone, 'UTC'))::date)), bn.night
       LIMIT 1)
     FROM property p WHERE p.id = b.property_id AND b.id = $1`, [bookingId]);
}

// Hold a new (or re-dated) stay: the booking row exists with its sold type;
// its booking_night rows don't. pickRoomId = the guest/staff named a room.
// Throws 409 when the type isn't sellable on some night, or a pick can't be had.
async function holdStay(client, { propertyId, bookingId, roomTypeId, nights, pickRoomId = null, movedBy = null }) {
  await lockType(client, roomTypeId);
  const counts = await typeCounts(client, propertyId, roomTypeId, nights);
  for (const n of nights) {
    if (!(counts.get(`${roomTypeId}|${n}`)?.sellable >= 1)) throw conflict('No rooms of this type available for the requested dates');
  }
  let roomId = null;
  let bumped = [];
  if (pickRoomId) {
    bumped = await claimRoom(client, { propertyId, roomId: pickRoomId, nights, selfId: bookingId, lockedTypes: [roomTypeId], movedBy });
    roomId = pickRoomId;
  } else {
    roomId = await freeRoom(client, propertyId, roomTypeId, nights);
  }
  await client.query(
    `INSERT INTO booking_night (booking_id, property_id, night, room_id)
     SELECT $1, $2, n, NULL FROM unnest($3::date[]) n`, [bookingId, propertyId, nights]);
  if (roomId) {
    await setNights(client, bookingId, nights, roomId);
    await logMove(client, { propertyId, bookingId, from: nights[0], to: addDaysIso(nights.at(-1), 1), toRoomId: roomId, reason: 'assign', movedBy });
  }
  await syncCurrentRoom(client, bookingId);
  return { placedNights: roomId ? nights : [], unplacedNights: roomId ? [] : nights, bumped };
}

// Make roomId free for selfId on every night: the room must have an open
// (or booking-held) flag each night, and any other holder must be bumpable --
// auto-assigned, not checked in, arriving after the property's lock cutoff.
// Bumped holders move to another room of their sold type for those nights,
// or wait without one. Returns the bumped booking ids; 409 otherwise.
async function claimRoom(client, { propertyId, roomId, nights, selfId, lockedTypes = [], movedBy = null }) {
  const { rows: flags } = await client.query(
    `SELECT ra.date::text AS night, ra.is_available, h.booking_id, b.room_pick, b.status, b.check_in::text, b.room_type_id
     FROM unnest($2::date[]) n(night)
     LEFT JOIN room_availability ra ON ra.room_id = $1 AND ra.date = n.night
     LEFT JOIN booking_night h ON h.room_id = $1 AND h.night = n.night
     LEFT JOIN booking b ON b.id = h.booking_id
     ORDER BY n.night`, [roomId, nights]);
  const { rows: [p] } = await client.query('SELECT room_lock_days FROM property WHERE id = $1', [propertyId]);
  const lockedUntil = addDaysIso(await propertyToday(client, propertyId), p.room_lock_days);
  const holders = new Map();
  for (const [i, f] of flags.entries()) {
    const night = nights[i];
    if (f.night == null || (!f.is_available && !f.booking_id)) throw conflict(`Room not available on ${night}`);
    if (!f.booking_id || f.booking_id === selfId) continue;
    if (f.room_pick || f.status === 'checked_in' || f.check_in <= lockedUntil) throw conflict(`Room not available on ${night}`);
    (holders.get(f.booking_id) ?? holders.set(f.booking_id, { type: f.room_type_id, nights: [] }).get(f.booking_id)).nights.push(night);
  }
  for (const type of [...new Set([...holders.values()].map((h) => h.type))].filter((t) => !lockedTypes.includes(t)).sort()) {
    await lockType(client, type);
  }
  const bumped = [];
  for (const [holderId, h] of holders) {
    await setNights(client, holderId, h.nights, null);
    const to = await freeRoom(client, propertyId, h.type, h.nights, roomId);
    if (to) await setNights(client, holderId, h.nights, to);
    await logMove(client, { propertyId, bookingId: holderId, from: h.nights[0], to: addDaysIso(h.nights.at(-1), 1),
      fromRoomId: roomId, toRoomId: to, reason: 'bump', movedBy });
    await syncCurrentRoom(client, holderId);
    bumped.push(holderId);
  }
  return bumped;
}

// Staff move: put the booking in roomId (any type, any active room) for
// nights [from, to). Price and sold type never change; the reason defaults to
// upgrade / downgrade by base rate against the sold type. Vacated rooms go to
// waiting bookings.
async function moveNights(client, booking, { roomId, from, to, reason = null, movedBy = null }) {
  const nights = [];
  for (let n = from; n < to; n = addDaysIso(n, 1)) nights.push(n);
  if (!nights.length) throw Object.assign(new Error('from must be before to'), { status: 400 });
  const { rows: [target] } = await client.query(
    `SELECT r.room_type_id, r.status, rt.base_rate, (SELECT base_rate FROM room_type WHERE id = $3) AS sold_rate
     FROM room r JOIN room_type rt ON rt.id = r.room_type_id WHERE r.id = $1 AND r.property_id = $2`,
    [roomId, booking.property_id, booking.room_type_id]);
  if (!target) throw Object.assign(new Error('Room not found'), { status: 404 });
  if (target.status !== 'active') throw conflict('Room is not active');
  const { rows: held } = await client.query(
    'SELECT night::text, room_id FROM booking_night WHERE booking_id = $1 AND night = ANY($2::date[]) ORDER BY night',
    [booking.id, nights]);
  if (held.length !== nights.length) throw Object.assign(new Error('Nights must be within the stay'), { status: 400 });
  const types = [...new Set([booking.room_type_id, target.room_type_id])].sort();
  for (const t of types) await lockType(client, t);
  await claimRoom(client, { propertyId: booking.property_id, roomId, nights, selfId: booking.id, lockedTypes: types, movedBy });
  const vacated = await setNights(client, booking.id, nights, roomId);
  const [rate, sold] = [Number(target.base_rate), Number(target.sold_rate)];
  await logMove(client, { propertyId: booking.property_id, bookingId: booking.id, from: nights[0], to,
    fromRoomId: held[0].room_id, toRoomId: roomId, reason: reason ?? (rate > sold ? 'upgrade' : rate < sold ? 'downgrade' : 'move'), movedBy });
  await syncCurrentRoom(client, booking.id);
  await refill(client, booking.property_id, vacated);
}

// Give waiting bookings sold as roomTypeId (nights without a room, among
// `nights`) a room of that type free on all their unplaced nights, oldest
// booking first. Cross-type placement is staff-only (moveNights).
async function assignWaiting(client, propertyId, roomTypeId, nights) {
  await lockType(client, roomTypeId);
  const { rows: waiting } = await client.query(
    `SELECT b.id FROM booking b
     WHERE b.property_id = $1 AND b.room_type_id = $2 AND b.status = ANY($4::text[])
       AND EXISTS (SELECT 1 FROM booking_night bn WHERE bn.booking_id = b.id AND bn.room_id IS NULL AND bn.night = ANY($3::date[]))
     ORDER BY b.created_at, b.id`, [propertyId, roomTypeId, nights, HOLDING]);
  for (const { id } of waiting) {
    const { rows } = await client.query(
      `SELECT night::text FROM booking_night WHERE booking_id = $1 AND room_id IS NULL ORDER BY night`, [id]);
    const mine = rows.map((r) => r.night);
    const to = await freeRoom(client, propertyId, roomTypeId, mine);
    if (!to) continue;
    await setNights(client, id, mine, to);
    await logMove(client, { propertyId, bookingId: id, from: mine[0], to: addDaysIso(mine.at(-1), 1), toRoomId: to, reason: 'assign' });
    await syncCurrentRoom(client, id);
  }
}

// A booking stops holding nights (all, or from fromNight on): cancel, expire,
// walk, early check-out, channel cancel/modify. Freed rooms go to whoever is
// waiting for that room's type.
async function releaseNights(client, booking, fromNight = null, { refillNow = true } = {}) {
  const { rows } = await client.query(
    `DELETE FROM booking_night WHERE booking_id = $1 AND ($2::date IS NULL OR night >= $2::date)
     RETURNING night::text, room_id`, [booking.id, fromNight]);
  const freed = new Map();
  for (const r of rows) if (r.room_id) (freed.get(r.room_id) ?? freed.set(r.room_id, []).get(r.room_id)).push(r.night);
  // A booking the old code made between migration A and B has no night rows:
  // reopen its room over the stay as the old code did (nights nobody holds).
  if (!rows.length && fromNight === null && booking.room_id) {
    await client.query(
      `UPDATE room_availability ra SET is_available = true
       WHERE ra.room_id = $1 AND ra.date >= $2 AND ra.date < $3 AND ra.block_reason IS NULL
         AND NOT EXISTS (SELECT 1 FROM booking_night h WHERE h.room_id = ra.room_id AND h.night = ra.date)`,
      [booking.room_id, booking.check_in, booking.check_out]);
  }
  for (const [roomId, ns] of freed) await setFlags(client, roomId, ns, true);
  if (refillNow) await refill(client, booking.property_id, freed);
  return freed; // refillNow false: the caller re-holds first, then refill()s
}

// assignWaiting for each freed room's type over the nights it freed.
async function refill(client, propertyId, freed) {
  if (!freed.size) return;
  const { rows: types } = await client.query('SELECT id, room_type_id FROM room WHERE id = ANY($1::uuid[])', [[...freed.keys()]]);
  const byType = new Map();
  for (const t of types) byType.set(t.room_type_id, [...(byType.get(t.room_type_id) ?? []), ...freed.get(t.id)]);
  for (const type of [...byType.keys()].sort()) await assignWaiting(client, propertyId, type, [...new Set(byType.get(type))]);
}

function addDaysIso(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

module.exports = {
  HOLDING, typeCounts, lockType, propertyToday, logMove, freeRoom, setNights, syncCurrentRoom, holdStay, addDaysIso,
  assignWaiting, releaseNights, refill, claimRoom, moveNights,
};
