// Checks room_type.hotel (a hotel label grouping room types inside one
// property): set/clear/validate through the controller, the list filter and
// the basket-quote filter. Throwaway property, deleted afterwards. Local DB
// only, with migrate-2026-11-09-room-type-hotel.sql applied.
//   node -r dotenv/config scripts/check-room-type-hotel.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { createRoomType, updateRoomType, listRoomTypes } = require('../src/controllers/roomTypes');
const roomQuote = require('../src/lib/roomQuote');

// Runs a controller; resolves { status, body } from res or the next(err).
function call(fn, property_id, body, params = {}, query = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query }, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}

(async () => {
  let P;
  try {
    P = (await pool.query("INSERT INTO property (name) VALUES ('Hotel Label Check') RETURNING id")).rows[0].id;
    const base = { max_occupancy: 2 };

    const q = await call(createRoomType, P, { ...base, base_rate: 900, name: 'Pavilion', hotel: '  qualia ' });
    assert.equal(q.status, 201); assert.equal(q.body.hotel, 'qualia', 'trimmed');
    const r = await call(createRoomType, P, { ...base, base_rate: 300, name: 'Garden View', hotel: 'Reef View Hotel' });
    assert.equal(r.status, 201);
    const none = await call(createRoomType, P, { ...base, base_rate: 200, name: 'Holiday Home' });
    assert.equal(none.body.hotel, null, 'optional');

    assert.equal((await call(createRoomType, P, { ...base, base_rate: 1, name: 'X', hotel: '  ' })).status, 400, 'blank refused');
    assert.equal((await call(createRoomType, P, { ...base, base_rate: 1, name: 'X', hotel: 'x'.repeat(101) })).status, 400, 'too long');
    assert.equal((await call(createRoomType, P, { ...base, base_rate: 1, name: 'X', hotel: 5 })).status, 400, 'non-string');

    const id = { id: none.body.id };
    assert.equal((await call(updateRoomType, P, { hotel: 'Holiday Homes' }, id)).body.hotel, 'Holiday Homes');
    assert.equal((await call(updateRoomType, P, { name: 'Holiday Home 2' }, id)).body.hotel, 'Holiday Homes', 'omitted kept');
    assert.equal((await call(updateRoomType, P, { hotel: '' }, id)).status, 400);
    assert.equal((await call(updateRoomType, P, { hotel: null }, id)).body.hotel, null, 'null clears');

    assert.equal((await call(listRoomTypes, P, {})).body.length, 3, 'no filter = all');
    assert.deepEqual((await call(listRoomTypes, P, {}, {}, { hotel: 'qualia' })).body.map((t) => t.name), ['Pavilion']);

    // Quote: cheapest type wins unfiltered; the filter keeps rooms in one hotel.
    for (const [t, n] of [[q.body.id, 'Q1'], [r.body.id, 'R1'], [none.body.id, 'H1']]) {
      await pool.query('INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3)', [P, t, n]);
    }
    await pool.query(
      `INSERT INTO room_availability (property_id, room_id, date)
       SELECT $1, r.id, d::date FROM room r, generate_series('2030-03-01'::date, '2030-03-02'::date, '1 day') d
       WHERE r.property_id = $1`, [P]);
    const stay = { check_in: '2030-03-01', check_out: '2030-03-03', rooms: [{ adults: 2 }] };
    assert.equal((await roomQuote.quote(pool, P, stay)).rooms[0].room_type_id, none.body.id);
    const onlyQ = await roomQuote.quote(pool, P, { ...stay, hotel: 'qualia' });
    assert.equal(onlyQ.available, true); assert.equal(onlyQ.rooms[0].room_type_id, q.body.id);
    assert.deepEqual(onlyQ.rooms[0].options.map((o) => o.room_type_id), [], 'no other-hotel options');
    await assert.rejects(roomQuote.quote(pool, P, { ...stay, hotel: 5 }), { status: 400 });
    console.log('ok   room type hotel');
  } finally {
    if (P) {
      await pool.query('DELETE FROM room_availability WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM room WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM room_type WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM property WHERE id = $1', [P]);
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
