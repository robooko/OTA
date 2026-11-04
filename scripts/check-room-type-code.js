// Checks room_type.code (max 3 chars, unique per property) through the
// controller against the local DB. Creates a throwaway property and deletes
// it afterwards. Never point this at the live DB.
//   node -r dotenv/config scripts/check-room-type-code.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { createRoomType, updateRoomType } = require('../src/controllers/roomTypes');

// Runs a controller; resolves { status, body } from res or the next(err).
function call(fn, property_id, body, params = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params }, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}

(async () => {
  const props = [];
  try {
    for (const n of ['Code Check A', 'Code Check B']) props.push((await pool.query('INSERT INTO property (name) VALUES ($1) RETURNING id', [n])).rows[0].id);
    const [A, B] = props;
    const base = { max_occupancy: 2, base_rate: 100 };

    const dbl = await call(createRoomType, A, { ...base, name: 'Double', code: 'DBL' });
    assert.equal(dbl.status, 201); assert.equal(dbl.body.code, 'DBL');
    const none = await call(createRoomType, A, { ...base, name: 'Twin' });
    assert.equal(none.status, 201); assert.equal(none.body.code, null);
    assert.equal((await call(createRoomType, A, { ...base, name: 'Suite' })).status, 201, 'many types without a code');

    assert.equal((await call(createRoomType, A, { ...base, name: 'X', code: 'DBLX' })).status, 400, '4 chars refused');
    assert.equal((await call(createRoomType, A, { ...base, name: 'X', code: '' })).status, 400, 'empty refused');
    assert.equal((await call(createRoomType, A, { ...base, name: 'X', code: 12 })).status, 400, 'non-string refused');
    assert.equal((await call(createRoomType, A, { ...base, name: 'X', code: 'DBL' })).status, 409, 'dupe in property');
    assert.equal((await call(createRoomType, B, { ...base, name: 'Double', code: 'DBL' })).status, 201, 'other property may reuse');

    const id = { id: none.body.id };
    assert.equal((await call(updateRoomType, A, { code: 'DBL' }, id)).status, 409, 'update dupe');
    assert.equal((await call(updateRoomType, A, { code: 'TWNN' }, id)).status, 400);
    assert.equal((await call(updateRoomType, A, { code: 'TWN' }, id)).body.code, 'TWN');
    assert.equal((await call(updateRoomType, A, { name: 'Twin Room' }, id)).body.code, 'TWN', 'omitted code kept');
    assert.equal((await call(updateRoomType, A, { code: null }, id)).body.code, null, 'null clears');
    console.log('ok   room type code');
  } finally {
    if (props.length) await pool.query('DELETE FROM room_type WHERE property_id = ANY($1)', [props]);
    if (props.length) await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
