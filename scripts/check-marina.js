// Checks the marina module against the local DB. Every fixture lives inside
// one transaction that is rolled back, so nothing persists. Never point
// this at the live DB.
//   node -r dotenv/config scripts/check-marina.js
delete process.env.RESEND_API_KEY;
process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret';
require('../src/db'); // DATE as 'YYYY-MM-DD' strings
const assert = require('node:assert/strict');
const { Client } = require('pg');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
    // Every check starts from the same fixtures: nothing one check inserts
    // is seen by the next.
    await db.query('ROLLBACK TO SAVEPOINT c');
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  // An expected error aborts the transaction; its own savepoint keeps the
  // rest of the check usable.
  const rejects = async (fn, code) => {
    await db.query('SAVEPOINT r');
    await assert.rejects(fn(), (e) => e.code === code);
    await db.query('ROLLBACK TO SAVEPOINT r');
  };

  try {
    const P = (await one(`INSERT INTO property (name, timezone, currency) VALUES ('Marina Check', 'Europe/Rome', 'EUR') RETURNING id`)).id;
    const marina = await one(`INSERT INTO marina (property_id, name, slug) VALUES ($1, 'Porto Check', 'porto-check') RETURNING *`, [P]);
    const berth = (label, extra = {}) => one(
      `INSERT INTO marina_berth (property_id, marina_id, label, length_m, beam_m, price_per_night, price_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [P, marina.id, label, extra.length_m ?? 12, extra.beam_m ?? 4, extra.price_per_night ?? 5, extra.price_mode ?? 'per_metre']);
    const berthA = await berth('A1');
    const berthB = await berth('A2', { price_mode: 'fixed', price_per_night: 80 });
    const booking = (berthId, arrival, departure, status = 'confirmed', source = 'staff') => one(
      `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, arrival, departure, status, source)
       VALUES ($1, $2, $3, 'Check', $4, $5, $6, $7) RETURNING *`,
      [P, marina.id, berthId, arrival, departure, status, source]);

    // ---- Task 1: overlap constraint ----
    await check('adjacent stays are allowed', async () => {
      await booking(berthA.id, '2027-06-01', '2027-06-05');
      await booking(berthA.id, '2027-06-05', '2027-06-08');
    });
    await check('overlapping stays are rejected', async () => {
      await booking(berthA.id, '2027-06-01', '2027-06-05');
      await rejects(() => booking(berthA.id, '2027-06-04', '2027-06-06'), '23P01');
    });
    await check('open-ended blocks every later date', async () => {
      await booking(berthA.id, '2027-07-01', null);
      await rejects(() => booking(berthA.id, '2028-01-01', '2028-01-03'), '23P01');
    });
    await check('cancelled and declined rows do not block', async () => {
      await booking(berthA.id, '2027-08-01', '2027-08-05', 'cancelled');
      await booking(berthA.id, '2027-08-01', '2027-08-05', 'declined');
      await booking(berthA.id, '2027-08-01', '2027-08-05', 'hold', 'guest');
    });
    await check('departure must be after arrival', async () => {
      await rejects(() => booking(berthA.id, '2027-09-05', '2027-09-05'), '23514');
    });

    // ---- Task 2: priceStay ----
    const { priceStay } = require('../src/lib/marinaPricing');
    const tier = (o) => ({ id: o.id ?? 't', valid_from: '2027-06-01', valid_to: '2027-06-30', max_length_m: '12.00', max_beam_m: null, price_per_night: '50.00', ...o });
    await check('per-metre berth price, no tiers', async () => {
      const r = priceStay({ berth: berthA, tiers: [], arrival: '2027-06-01', departure: '2027-06-04', boatLengthM: 10.5, boatBeamM: null });
      assert.deepEqual(r, { nights: 3, total_price: '157.50', tier_id: null }); // 5 × 10.5 × 3
    });
    await check('fixed berth price', async () => {
      const r = priceStay({ berth: berthB, tiers: [], arrival: '2027-06-01', departure: '2027-06-03', boatLengthM: 9, boatBeamM: null });
      assert.equal(r.total_price, '160.00');
    });
    await check('smallest fitting tier wins', async () => {
      const tiers = [tier({ id: 'big', max_length_m: '20.00', price_per_night: '90.00' }), tier({ id: 'small', max_length_m: '12.00' })];
      const r = priceStay({ berth: berthA, tiers, arrival: '2027-06-10', departure: '2027-06-12', boatLengthM: 11, boatBeamM: null });
      assert.deepEqual(r, { nights: 2, total_price: '100.00', tier_id: 'small' });
    });
    await check('tier matches on boat length, not berth length', async () => {
      const r = priceStay({ berth: berthA, tiers: [tier({ max_length_m: '8.00' })], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 7.5, boatBeamM: null });
      assert.equal(r.tier_id, 't'); // berth is 12 m, boat 7.5 m
    });
    await check('stay ending the day after valid_to is covered; one more night is not', async () => {
      const t = [tier({})];
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-28', departure: '2027-07-01', boatLengthM: 10, boatBeamM: null }).tier_id, 't');
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-28', departure: '2027-07-02', boatLengthM: 10, boatBeamM: null }).tier_id, null);
    });
    await check('beam limit applies only when both are set', async () => {
      const t = [tier({ max_beam_m: '3.50' })];
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10, boatBeamM: 4 }).tier_id, null);
      assert.equal(priceStay({ berth: berthA, tiers: t, arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10, boatBeamM: null }).tier_id, 't');
    });
    await check('no price anywhere → null total (request-only)', async () => {
      const r = priceStay({ berth: { ...berthA, price_per_night: null }, tiers: [], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10, boatBeamM: null });
      assert.equal(r.total_price, null);
    });
    await check('open-ended → null total', async () => {
      assert.equal(priceStay({ berth: berthA, tiers: [], arrival: '2027-06-10', departure: null, boatLengthM: 10, boatBeamM: null }).total_price, null);
    });
    await check('2-dp rounding of per-metre', async () => {
      const r = priceStay({ berth: { ...berthA, price_per_night: '3.33' }, tiers: [], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: 10.15, boatBeamM: null });
      assert.equal(r.total_price, '33.80'); // 3.33 × 10.15 = 33.7995
    });
    const { closedFor, seasons, datedTier } = require('../src/lib/marinaPricing');
    await check('repeating season prices later years; one-off does not', async () => {
      const summer = tier({ valid_from: '2026-05-01', valid_to: '2026-10-31', repeats_yearly: true });
      assert.equal(priceStay({ berth: berthA, tiers: [summer], arrival: '2028-07-01', departure: '2028-07-03', boatLengthM: 10, boatBeamM: null }).tier_id, 't');
      assert.ok(!closedFor([summer], '2028-07-01', '2028-07-03'));
      assert.ok(closedFor([summer], '2028-11-01', '2028-11-02'));
      assert.ok(closedFor([{ ...summer, repeats_yearly: false }], '2028-07-01', '2028-07-03'));
    });
    await check('repeating winter season wraps New Year', async () => {
      const winter = tier({ valid_from: '2026-11-01', valid_to: '2027-03-31', repeats_yearly: true });
      assert.ok(!closedFor([winter], '2029-12-30', '2030-01-03')); // crosses 31 Dec
      assert.ok(!closedFor([winter], '2030-02-01', '2030-02-05')); // window began 2029
      assert.ok(closedFor([winter], '2030-03-30', '2030-04-02'));
      assert.deepEqual(seasons([winter], '2030-02-01'), [{ from: '2029-11-01', to: '2030-03-31' }, { from: '2030-11-01', to: '2031-03-31' }, { from: '2031-11-01', to: '2032-03-31' }]);
      assert.deepEqual([datedTier(winter, '2030-04-15').valid_from, datedTier(winter, '2030-04-15').valid_to], ['2030-11-01', '2031-03-31']);
    });
    await check('activeTiers takes season dates and drops inactive seasons', async () => {
      const q = require('../src/lib/marinaQueries');
      const s = await one(`INSERT INTO marina_season (property_id, marina_id, name, valid_from, valid_to, repeats_yearly) VALUES ($1, $2, 'Summer', '2026-05-01', '2026-10-31', true) RETURNING id`, [P, marina.id]);
      await db.query(`INSERT INTO marina_price_tier (property_id, marina_id, season_id, max_length_m, price_per_night) VALUES ($1, $2, $3, 12, 50)`, [P, marina.id, s.id]);
      const [t] = (await q.activeTiers(db, marina.id)).filter((x) => x.season_id === s.id);
      assert.deepEqual([t.valid_from, t.valid_to, t.repeats_yearly, t.season_name], ['2026-05-01', '2026-10-31', true, 'Summer']);
      await db.query(`UPDATE marina_season SET status = 'inactive' WHERE id = $1`, [s.id]);
      assert.equal((await q.activeTiers(db, marina.id)).filter((x) => x.season_id === s.id).length, 0);
    });
    await check('tier needs a season or its own dates', async () => {
      await rejects(() => db.query(`INSERT INTO marina_price_tier (property_id, marina_id, max_length_m, price_per_night) VALUES ($1, $2, 12, 50)`, [P, marina.id]), '23514');
    });
    await check('no boat length falls back to berth length (staff)', async () => {
      const r = priceStay({ berth: berthA, tiers: [], arrival: '2027-06-10', departure: '2027-06-11', boatLengthM: null, boatBeamM: null });
      assert.equal(r.total_price, '60.00'); // 5 × 12
    });

    // ---- Task 3: token + guards ----
    const { bookingToken, bookingTokenMatches } = require('../src/lib/marinaToken');
    const guard = require('../src/lib/marinaGuard');
    await check('booking token round-trips and rejects others', async () => {
      const id = '6f1c0d4e-0000-4000-8000-000000000001';
      assert.ok(bookingTokenMatches(id, bookingToken(id)));
      assert.ok(!bookingTokenMatches(id, bookingToken('6f1c0d4e-0000-4000-8000-000000000002')));
      assert.ok(!bookingTokenMatches(id, undefined));
      assert.ok(!bookingTokenMatches(id, 'short'));
    });
    const good = { berth_label: 'A1', arrival: '2027-06-01', departure: '2027-06-04', contact_name: 'Ann', contact_email: 'ann@example.com', boat_name: 'Wave', boat_length_m: 10 };
    await check('valid guest body passes and ignores status', async () => {
      const r = guard.validateGuestBooking({ ...good, status: 'confirmed' }, '2027-05-01');
      assert.ok(r.ok); assert.equal(r.value.status, undefined); assert.equal(r.value.locale, 'en');
    });
    await check('guest body rejects past arrival, missing departure, > 90 nights, bad email, no length', async () => {
      assert.ok(!guard.validateGuestBooking({ ...good, arrival: '2027-04-30' }, '2027-05-01').ok);
      assert.ok(!guard.validateGuestBooking({ ...good, departure: undefined }, '2027-05-01').ok);
      assert.ok(!guard.validateGuestBooking({ ...good, departure: '2027-09-01' }, '2027-05-01').ok);
      assert.ok(!guard.validateGuestBooking({ ...good, contact_email: 'nope' }, '2027-05-01').ok);
      assert.ok(!guard.validateGuestBooking({ ...good, boat_length_m: undefined }, '2027-05-01').ok);
    });
    await check('berth fit skips NULL limits', async () => {
      assert.equal(guard.berthFitError({ length_m: null, min_length_m: null, beam_m: null }, 30, 9), null);
      assert.match(guard.berthFitError({ length_m: '12', min_length_m: null, beam_m: null }, 13, null), /long/);
      assert.match(guard.berthFitError({ length_m: '12', min_length_m: '10', beam_m: null }, 8, null), /short/);
      assert.equal(guard.berthFitError({ length_m: '12', min_length_m: null, beam_m: '4' }, 10, null), null);
      assert.match(guard.berthFitError({ length_m: '12', min_length_m: null, beam_m: '4' }, 10, 4.5), /beam/);
    });
    await check('email cap counts dot/+tag variants as one guest', async () => {
      const add = (email, arrival, departure) => db.query(
        `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, contact_email, contact_email_key, arrival, departure, status, source)
         VALUES ($1, $2, $3, 'X', $4, $5, $6, $7, 'pending', 'guest')`,
        [P, marina.id, berthB.id, email, require('../src/lib/spaBookingGuard').emailKey(email), arrival, departure]);
      await add('j.o.e@gmail.com', '2027-10-01', '2027-10-02');
      await add('joe+boat@gmail.com', '2027-10-03', '2027-10-04');
      assert.ok((await guard.checkEmailCap(db, P, 'joe@googlemail.com', '2027-05-01')).ok);
      await add('JOE@gmail.com', '2027-10-05', '2027-10-06');
      assert.ok(!(await guard.checkEmailCap(db, P, 'joe@gmail.com', '2027-05-01')).ok);
      assert.ok((await guard.checkEmailCap(db, P, 'joe@gmail.com', '2027-10-06')).ok, 'past stays no longer count');
    });
    await check('clientIp only on the key rail, IPv6 grouped by /64', async () => {
      const req = (h, rail = 'api_key') => ({ auth_method: rail, headers: h, property_id: P });
      assert.equal(guard.clientIp(req({ 'x-client-ip': '203.0.113.9' })), '203.0.113.9');
      assert.equal(guard.clientIp(req({ 'x-client-ip': '203.0.113.9' }, 'bearer')), null);
      assert.equal(guard.clientIp(req({ 'x-client-ip': '2001:db8:1:2:aaaa::1' })), guard.clientIp(req({ 'x-client-ip': '2001:db8:1:2:bbbb::9' })));
      assert.equal(guard.clientIp(req({ 'x-client-ip': 'not-an-ip' })), null);
      assert.equal(guard.clientIpKey(req({})), `property:${P}`);
    });

    // ---- Task 4: label rename ----
    const { renameBerthInSvg } = require('../src/controllers/marinaCatalogue');
    await check('renameBerthInSvg rewrites only the exact data-berth-id', async () => {
      const svg = '<g><rect data-berth-id="P1"/><rect data-berth-id="P10"/><rect data-berth-id=\'P1\'/></g>';
      assert.equal(renameBerthInSvg(svg, 'P1', 'Q1'), '<g><rect data-berth-id="Q1"/><rect data-berth-id="P10"/><rect data-berth-id=\'Q1\'/></g>');
      assert.equal(renameBerthInSvg(null, 'P1', 'Q1'), null);
    });
    await check('label with regex characters is escaped', async () => {
      assert.equal(renameBerthInSvg('<r data-berth-id="A.1"/><r data-berth-id="AX1"/>', 'A.1', 'B'), '<r data-berth-id="B"/><r data-berth-id="AX1"/>');
    });

    // ---- Task 5: availability ----
    const q = require('../src/lib/marinaQueries');
    await check('freeBerths excludes overlapping live bookings, maintenance and inactive', async () => {
      const c = await berth('C1'); const d = await berth('C2'); const e = await berth('C3');
      await db.query("UPDATE marina_berth SET status = 'maintenance' WHERE id = $1", [d.id]);
      await db.query("UPDATE marina_berth SET status = 'inactive' WHERE id = $1", [e.id]);
      await booking(berthA.id, '2028-03-01', '2028-03-10', 'pending', 'guest');
      await booking(berthB.id, '2028-03-01', '2028-03-10', 'cancelled');
      const ids = (await q.freeBerths(db, marina.id, '2028-03-05', '2028-03-06')).map((b) => b.id);
      assert.ok(!ids.includes(berthA.id)); assert.ok(ids.includes(berthB.id)); assert.ok(ids.includes(c.id));
      assert.ok(!ids.includes(d.id)); assert.ok(!ids.includes(e.id));
      const avail = await q.berthAvailability(db, marina.id, '2028-03-05', '2028-03-06');
      assert.equal(avail.get(d.id), false); assert.equal(avail.has(e.id), false); assert.equal(avail.get(berthA.id), false);
    });
    await check('propertyToday uses the property timezone', async () => {
      assert.match(await q.propertyToday(db, P), /^\d{4}-\d{2}-\d{2}$/);
    });

    // ---- Task 10: sniff ----
    const { sniffType } = require('../src/lib/marinaDocuments');
    await check('magic bytes, not declared type', async () => {
      assert.equal(sniffType(Buffer.from('%PDF-1.7\n')), 'application/pdf');
      assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
      assert.equal(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
      assert.equal(sniffType(Buffer.from('<svg/>')), null);
      assert.equal(sniffType(Buffer.alloc(0)), null);
    });

    // ---- Task 11: contracts ----
    const kc = require('../src/lib/marinaContracts');
    await check('pickTemplate takes the highest min_nights <= nights', async () => {
      const t = [{ id: 'a', min_nights: 0 }, { id: 'b', min_nights: 7 }, { id: 'c', min_nights: 30 }];
      assert.equal(kc.pickTemplate(t, 3).id, 'a'); assert.equal(kc.pickTemplate(t, 7).id, 'b'); assert.equal(kc.pickTemplate(t, 365).id, 'c');
      assert.equal(kc.pickTemplate([], 3), null);
    });
    await check('renderContract fills Sidon merge fields, blanks document fields and unknowns', async () => {
      const out = kc.renderContract('{{sailor_name}} / {{ boat_loa }} m / {{acord25.policy}} / {{nope}}', { sailor_name: 'Ann', boat_loa: '10.50' });
      assert.equal(out, 'Ann / 10.50 m /  / ');
      assert.deepEqual(kc.unknownPlaceholders('{{sailor_name}} {{acord25.policy}} {{nope}}'), ['acord25.policy', 'nope']);
    });

    // ---- Task 13: MCP tools ----
    await check('MCP marina tools call the marina routes', async () => {
      const calls = [];
      const tools = require('../mcp-server/tools').createTools(async (method, path, opts) => { calls.push([method, path, opts]); return {}; });
      const t = (name) => { const x = tools.find((y) => y.name === name); assert.ok(x, `missing tool ${name}`); return x; };
      await t('list_marinas').run({});
      await t('update_marina_berth').run({ marina_id: 'm1', berth_id: 'b1', status: 'maintenance' });
      await t('search_berth_availability').run({ marina_slug: 'porto check', arrival: '2027-06-01', departure: '2027-06-03', boat_length_m: 10 });
      await t('update_marina_booking').run({ booking_id: 'k1', action: 'cancel', refund: true });
      assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), ['GET /api/marina/marinas', 'PUT /api/marina/marinas/m1/berths/b1', 'GET /api/marina/guest/porto%20check/availability', 'PUT /api/marina/bookings/k1']);
      assert.deepEqual(calls[1][2].body, { status: 'maintenance' });
      assert.deepEqual(calls[3][2].body, { action: 'cancel', refund: true });
      for (const n of ['get_marina', 'list_marina_berths', 'get_marina_booking', 'create_marina_booking']) t(n);
      // Switch: the staff list is OTA's own paged route; the args pass straight through as the query.
      calls.length = 0;
      const args = { from: '2027-06-01', status: 'pending', limit: 50 };
      await t('list_marina_bookings').run(args);
      assert.deepEqual(calls, [['GET', '/api/marina/bookings', { query: { from: '2027-06-01', status: 'pending', limit: 50 } }]]);
      assert.equal(t('list_marina_bookings').run.toString().includes('sidon-bookings'), false, 'no interim proxy after Switch');
    });
    await check('MCP marina catalogue and document tools call the marina routes', async () => {
      const calls = [];
      const tools = require('../mcp-server/tools').createTools(async (method, path, opts) => { calls.push([method, path, opts]); return {}; });
      const t = (name) => { const x = tools.find((y) => y.name === name); assert.ok(x, `missing tool ${name}`); return x; };
      const { z } = require('zod');
      assert.equal(z.object(t('create_marina').inputSchema).safeParse({ name: 'P' }).success, false, 'slug required on create');
      assert.equal(z.object(t('update_marina').inputSchema).safeParse({ marina_id: 'm1', status: 'inactive' }).success, true);
      await t('create_marina').run({ name: 'P', slug: 'p' });
      await t('update_marina').run({ marina_id: 'm1', auto_confirm: true });
      await t('bulk_upsert_marina_berths').run({ marina_id: 'm1', rows: [{ label: 'A1' }] });
      await t('list_marina_booking_documents').run({ booking_id: 'k1' });
      await t('get_marina_booking_verification').run({ booking_id: 'k1' });
      await t('update_marina_document').run({ document_id: 'd1', status: 'verified' });
      assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), ['POST /api/marina/marinas', 'PUT /api/marina/marinas/m1', 'POST /api/marina/marinas/m1/berths/bulk',
        'GET /api/marina/bookings/k1/documents', 'GET /api/marina/bookings/k1/verification', 'PUT /api/marina/documents/d1']);
      assert.deepEqual(calls[1][2].body, { auto_confirm: true });
      assert.deepEqual(calls[2][2].body, { rows: [{ label: 'A1' }] });
      assert.deepEqual(calls[5][2].body, { status: 'verified' });
    });
    await check('MCP doc requirement tools call the catalogue routes', async () => {
      const calls = [];
      const tools = require('../mcp-server/tools').createTools(async (method, path, opts) => { calls.push([method, path, opts]); return {}; });
      const t = (name) => { const x = tools.find((y) => y.name === name); assert.ok(x, `missing tool ${name}`); return x; };
      const { z } = require('zod');
      assert.equal(z.object(t('create_marina_doc_requirement').inputSchema).safeParse({ marina_id: 'm1', name: 'Passport' }).success, false, 'type required on create');
      await t('list_marina_doc_requirements').run({ marina_id: 'm1', include_inactive: true });
      await t('create_marina_doc_requirement').run({ marina_id: 'm1', type: 'passport', name: 'Passport', mandatory: true });
      await t('update_marina_doc_requirement').run({ marina_id: 'm1', requirement_id: 'r1', status: 'inactive' });
      assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), ['GET /api/marina/marinas/m1/doc-requirements', 'POST /api/marina/marinas/m1/doc-requirements', 'PUT /api/marina/marinas/m1/doc-requirements/r1']);
      assert.deepEqual(calls[0][2].query, { include_inactive: 1 });
      assert.deepEqual(calls[1][2].body, { type: 'passport', name: 'Passport', mandatory: true });
      assert.deepEqual(calls[2][2].body, { status: 'inactive' });
    });

    // (later tasks append their checks here)
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exitCode = failed ? 1 : 0;
})();
