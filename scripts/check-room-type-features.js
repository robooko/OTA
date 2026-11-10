// Checks room_type.features (search tags): set/normalise/validate/clear via
// the controller, and the all-tags-must-match filter on the list, availability
// search and basket quote. Throwaway property, deleted afterwards. Local DB
// only, with migrate-2026-11-10-room-type-features.sql applied.
//   node -r dotenv/config scripts/check-room-type-features.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { createRoomType, updateRoomType, listRoomTypes } = require('../src/controllers/roomTypes');
const { searchAvailability } = require('../src/controllers/availability');
const { refreshAvailabilityView } = require('../src/lib/roomPayments');
const roomQuote = require('../src/lib/roomQuote');

function call(fn, property_id, body, params = {}, query = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query, headers: {}, get: () => undefined }, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}
const names = (r) => r.body.map((t) => t.name).sort();

(async () => {
  let P;
  try {
    P = (await pool.query("INSERT INTO property (name) VALUES ('Features Check') RETURNING id")).rows[0].id;
    const base = { max_occupancy: 2 };

    const sea = await call(createRoomType, P, { ...base, base_rate: 900, name: 'Sea', features: ['Ocean View', 'fine-dining', 'ocean_view'] });
    assert.equal(sea.status, 201); assert.deepEqual(sea.body.features, ['ocean_view', 'fine_dining'], 'normalised + deduped');
    const garden = await call(createRoomType, P, { ...base, base_rate: 300, name: 'Garden', features: ['fine_dining'] });
    const plain = await call(createRoomType, P, { ...base, base_rate: 200, name: 'Plain' });
    assert.deepEqual(plain.body.features, [], 'defaults to []');

    for (const f of ['ocean_view', ['bad!'], [''], [5], Array.from({ length: 31 }, (_, i) => `t${i}`)]) {
      assert.equal((await call(createRoomType, P, { ...base, base_rate: 1, name: 'X', features: f })).status, 400, JSON.stringify(f));
    }

    const id = { id: plain.body.id };
    assert.deepEqual((await call(updateRoomType, P, { features: ['pool'] }, id)).body.features, ['pool']);
    assert.deepEqual((await call(updateRoomType, P, { name: 'Plain' }, id)).body.features, ['pool'], 'omitted kept');
    assert.deepEqual((await call(updateRoomType, P, { features: null }, id)).body.features, [], 'null clears');

    assert.deepEqual(names(await call(listRoomTypes, P, {})), ['Garden', 'Plain', 'Sea']);
    assert.deepEqual(names(await call(listRoomTypes, P, {}, {}, { features: 'fine_dining' })), ['Garden', 'Sea']);
    assert.deepEqual(names(await call(listRoomTypes, P, {}, {}, { features: 'Fine Dining,ocean_view' })), ['Sea'], 'all tags must match');
    assert.deepEqual(names(await call(listRoomTypes, P, {}, {}, { features: ['fine_dining', 'ocean_view'] })), ['Sea'], 'repeated param');
    assert.deepEqual(names(await call(listRoomTypes, P, {}, {}, { features: '' })), ['Garden', 'Plain', 'Sea'], 'empty = no filter');
    assert.equal((await call(listRoomTypes, P, {}, {}, { features: 'x!' })).status, 400);

    for (const [t, n] of [[sea.body.id, 'S1'], [garden.body.id, 'G1'], [plain.body.id, 'P1']]) {
      await pool.query('INSERT INTO room (property_id, room_type_id, room_number) VALUES ($1, $2, $3)', [P, t, n]);
    }
    await pool.query(
      `INSERT INTO room_availability (property_id, room_id, date)
       SELECT $1, r.id, d::date FROM room r, generate_series('2030-03-01'::date, '2030-03-02'::date, '1 day') d
       WHERE r.property_id = $1`, [P]);
    await refreshAvailabilityView();

    const q = { check_in: '2030-03-01', check_out: '2030-03-03', guests: '2', property_id: P };
    const all = await call(searchAvailability, undefined, {}, {}, q);
    assert.equal(all.status, 200, JSON.stringify(all.body)); assert.equal(all.body.length, 3);
    const s = await call(searchAvailability, undefined, {}, {}, { ...q, features: 'ocean_view' });
    assert.deepEqual(s.body.map((r) => r.name), ['Sea']); assert.deepEqual(s.body[0].features, ['ocean_view', 'fine_dining']);

    const stay = { check_in: '2030-03-01', check_out: '2030-03-03', rooms: [{ adults: 2 }] };
    assert.equal((await roomQuote.quote(pool, P, stay)).rooms[0].room_type_id, plain.body.id, 'cheapest unfiltered');
    assert.equal((await roomQuote.quote(pool, P, { ...stay, features: ['fine_dining'] })).rooms[0].room_type_id, garden.body.id);
    assert.equal((await roomQuote.quote(pool, P, { ...stay, features: ['ocean_view'] })).rooms[0].room_type_id, sea.body.id);
    assert.equal((await roomQuote.quote(pool, P, { ...stay, features: ['spa'] })).available, false);
    await assert.rejects(roomQuote.quote(pool, P, { ...stay, features: [5] }), { status: 400 });
    console.log('ok   room type features');
  } finally {
    if (P) {
      await pool.query('DELETE FROM room_availability WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM room WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM room_type WHERE property_id = $1', [P]);
      await pool.query('DELETE FROM property WHERE id = $1', [P]);
      await refreshAvailabilityView();
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
