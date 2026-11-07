// Checks /api/availability/competitor-alerts (report, list, acknowledge)
// through the controller against the local DB. Creates throwaway properties
// and deletes them afterwards.
//   node -r dotenv/config scripts/check-competitor-alerts.js
const assert = require('node:assert/strict');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');
const pool = require('../src/db');
const { reportAlerts, listAlerts, acknowledgeAlert } = require('../src/controllers/competitorAlerts');

function call(fn, property_id, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(s) { this.statusCode = s; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    fn({ property_id, body, params, query }, res, (err) => resolve({ status: err.status || 500, body: { error: err.message } }));
  });
}
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];

(async () => {
  const props = [];
  try {
    for (const n of ['Comp Check A', 'Comp Check B']) props.push((await one('INSERT INTO property (name) VALUES ($1) RETURNING id', [n])).id);
    const [A, B] = props;
    const rt = async (P) => (await one(`INSERT INTO room_type (property_id, name, max_occupancy, base_rate) VALUES ($1, 'Std', 2, 100) RETURNING id`, [P])).id;
    const rtA = await rt(A);
    const rtB = await rt(B);
    const report = (P, alerts) => call(reportAlerts, P, { body: { alerts } });
    const sold = { night: '2030-06-01', room_type_id: rtA, competitor: 'Hotel Rival', type: 'sold_out' };
    const moved = { night: '2030-06-02', room_type_id: rtA, competitor: 'Hotel Rival', type: 'price_change', old_price: 150, new_price: 180 };

    const bad = [[], [{ ...sold, night: '2030-13-01' }], [{ ...sold, room_type_id: 'x' }], [{ ...sold, competitor: ' ' }],
      [{ ...sold, type: 'cheaper' }], [{ ...moved, new_price: undefined }], [{ ...moved, old_price: '150' }], [{ ...sold, room_type_confirmed: 'yes' }]];
    for (const alerts of bad) assert.equal((await report(A, alerts)).status, 400, JSON.stringify(alerts));

    const r1 = await report(A, [sold, moved, { ...sold, room_type_id: rtB }]);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.deepEqual(r1.body, { created: 2, updated: 0, unknown: [rtB] }, "other property's room type skipped");

    // Repeat: updates the open alert, keeps the first old_price; in-batch duplicates collapse.
    const r2 = await report(A, [{ ...moved, old_price: 180, new_price: 200, room_type_confirmed: true }, { ...sold }, { ...sold }]);
    assert.deepEqual(r2.body, { created: 0, updated: 2, unknown: [] });
    let list = (await call(listAlerts, A)).body;
    assert.equal(list.length, 2);
    const pc = list.find((a) => a.type === 'price_change');
    assert.equal(pc.night, '2030-06-02'); assert.equal(pc.old_price, '150.00'); assert.equal(pc.new_price, '200.00');
    assert.equal(pc.room_type_confirmed, true); assert.equal(pc.room_type_name, 'Std');

    assert.equal((await call(listAlerts, A, { query: { type: 'sold_out' } })).body.length, 1);
    assert.equal((await call(listAlerts, A, { query: { from: '2030-06-02', to: '2030-06-03' } })).body[0].type, 'price_change', 'to exclusive');
    assert.equal((await call(listAlerts, A, { query: { from: 'nope' } })).status, 400);
    assert.equal((await call(listAlerts, B)).body.length, 0, 'B sees none');

    const so = list.find((a) => a.type === 'sold_out');
    assert.equal((await call(acknowledgeAlert, B, { params: { id: so.id } })).status, 404, "can't ack another property's alert");
    assert.ok((await call(acknowledgeAlert, A, { params: { id: so.id } })).body.acknowledged_at);
    assert.equal((await call(listAlerts, A)).body.length, 1, 'acked hidden by default');
    assert.equal((await call(listAlerts, A, { query: { acknowledged: 'true' } })).body.length, 1);

    // Acked alert closed: the same report opens a new one.
    assert.deepEqual((await report(A, [sold])).body, { created: 1, updated: 0, unknown: [] });
    assert.equal((await call(listAlerts, A, { query: { acknowledged: 'all' } })).body.length, 3);
    console.log('ok   competitor alerts');
  } finally {
    if (props.length) {
      await pool.query('DELETE FROM competitor_alert WHERE property_id = ANY($1)', [props]);
      await pool.query('DELETE FROM room_type WHERE property_id = ANY($1)', [props]);
      await pool.query('DELETE FROM property WHERE id = ANY($1)', [props]);
    }
    await pool.end();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
