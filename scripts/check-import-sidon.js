// Checks scripts/import-sidon-marina.js against the local DB. A small Sidon
// fixture lives in its own schema (sidon_fixture: Sidon's table names collide
// with OTA's), and everything happens inside one transaction that is rolled
// back. Never point this at the live DB.
//   node -r dotenv/config scripts/check-import-sidon.js
process.env.MARINA_BOOKING_TOKEN_SECRET ||= 'check-secret';
require('../src/db'); // DATE as 'YYYY-MM-DD' strings
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');
const I = require('./import-sidon-marina');

if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

// Sidon's live types (survey sidon-import.md §1), only the columns the importer reads.
const FIXTURE_DDL = `
CREATE SCHEMA sidon_fixture;
CREATE TABLE sidon_fixture.marina_profile (owner_id text PRIMARY KEY, slug text, name text NOT NULL, lat double precision, lng double precision,
  description text, phone text, email text, website text, response_window_hours int, currency text NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_layout (owner_id text PRIMARY KEY, svg_data text, sw_lat double precision, sw_lng double precision,
  ne_lat double precision, ne_lng double precision, rotation real);
CREATE TABLE sidon_fixture.marina_overlay (id serial PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, svg_data text, sw_lat double precision,
  sw_lng double precision, ne_lat double precision, ne_lng double precision, rotation double precision, sort_order int);
CREATE TABLE sidon_fixture.marina_berth (id serial PRIMARY KEY, owner_id text NOT NULL, berth_id text NOT NULL, overlay_id int, lat double precision,
  lng double precision, length_m real, min_length_m real, beam_m real, depth_m real, status text NOT NULL, guest_name text, notes text,
  price_per_night real, price_mode text, rotation real);
CREATE TABLE sidon_fixture.marina_price_tier (id serial PRIMARY KEY, owner_id text NOT NULL, valid_from text NOT NULL, valid_to text NOT NULL,
  max_len_m real NOT NULL, max_beam_m real, price_per_night int NOT NULL, price_per_month int, price_per_year int, created_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.berth_booking (id serial PRIMARY KEY, owner_id text NOT NULL, berth_id text NOT NULL, sailor_name text NOT NULL,
  sailor_email text NOT NULL, boat_name text NOT NULL, boat_loa real, boat_beam real, arrival_date text NOT NULL, departure_date text NOT NULL,
  notes text, status text NOT NULL, payment_intent_id text, amount_cents int, expires_at timestamptz, created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_doc_requirement (id serial PRIMARY KEY, owner_id text NOT NULL, type text NOT NULL, name text NOT NULL,
  description text, schema text NOT NULL, mandatory int NOT NULL, sort_order int);
CREATE TABLE sidon_fixture.marina_document (id serial PRIMARY KEY, owner_id text NOT NULL, requirement_id int NOT NULL, booking_id int,
  status text NOT NULL, notes text, submitted_at timestamptz NOT NULL, verified_at timestamptz, type text, file_url text, file_name text,
  extracted_data text, expiry_date timestamptz);
CREATE TABLE sidon_fixture.marina_contract_template (id serial PRIMARY KEY, owner_id text NOT NULL, name text NOT NULL, body_markdown text NOT NULL,
  min_nights int, active int NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_contract_signature (id serial PRIMARY KEY, owner_id text NOT NULL, template_id int NOT NULL, booking_id int NOT NULL,
  rendered_body text NOT NULL, signed_at timestamptz NOT NULL, ip_address text, user_agent text);
CREATE TABLE sidon_fixture.marina_poi (id serial PRIMARY KEY, owner_id text NOT NULL, label text NOT NULL, type text NOT NULL,
  lat double precision NOT NULL, lng double precision NOT NULL);
CREATE TABLE sidon_fixture.marina_image (id serial PRIMARY KEY, owner_id text NOT NULL, url text NOT NULL, description text, sort_order int,
  created_at timestamptz NOT NULL);
CREATE TABLE sidon_fixture.marina_message (id serial PRIMARY KEY, owner_id text NOT NULL, sailor_id text, enquiry_cookie_hash text, sailor_email text,
  sailor_name text, direction text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL, read_at timestamptz);
`;

// Owners: FOX and PEV share one created property (G1), BB reuses a GBP
// property with a eur marina (currency flag), GHOST is profile-less with
// berths on FOX's overlay (re-key suggestion), CHAT has only messages
// (auto-skip, G13), AMB has bookings whose label is in FOX and PEV (no
// single suggestion).
const FOX = 'org_fixFox', PEV = 'org_fixPevero', BB = 'org_fixBbyc', GHOST = 'user_fixGhost', CHAT = 'user_fixChat', AMB = 'user_fixAmb';
const EMAIL = 'skipper.fixture@example.com', SAILOR = 'Fixture Skipper', GUEST = 'Fixture Guest';
const FIXTURE_ROWS = `
INSERT INTO sidon_fixture.marina_profile VALUES
  ('${FOX}', 'fox-mooring', 'Fox Mooring', 41.1, 9.5, '', '', '', NULL, 24, 'eur', '2026-08-01T00:00:00Z'),
  ('${PEV}', NULL, 'Pevero Mooring', 41.1, 9.5, 'Moorings', NULL, 'office.fixture@example.com', NULL, 24, 'eur', '2026-08-01T00:00:00Z'),
  ('${BB}', 'bbyc', 'Fixture Yacht Club', -16.5, -151.7, NULL, NULL, NULL, NULL, 24, 'eur', '2026-08-01T00:00:00Z');
INSERT INTO sidon_fixture.marina_layout VALUES ('${FOX}', '<svg/>', 41.0, 9.4, 41.2, 9.6, 12.5);
INSERT INTO sidon_fixture.marina_overlay (id, owner_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order) VALUES
  (1, '${FOX}', 'Pontoon A', '<path/>', 41.0, 9.4, 41.1, 9.5, 0, 1);
INSERT INTO sidon_fixture.marina_berth (id, owner_id, berth_id, overlay_id, length_m, beam_m, status, guest_name, price_per_night, price_mode) VALUES
  (1, '${FOX}', 'A1', 1, 12, 4, 'available', NULL, 5, 'per_metre'),
  (2, '${FOX}', 'S1', 1, 10, 3.5, 'occupied', '${GUEST}', 5, 'per_metre'),
  (3, '${PEV}', 'S1', NULL, 15, 5, 'available', NULL, 80, 'fixed'),
  (4, '${BB}', 'B1', NULL, 20, 6, 'reserved', NULL, 100, 'fixed'),
  (5, '${GHOST}', 'A1', 1, 12, 4, 'available', NULL, 5, 'per_metre');
INSERT INTO sidon_fixture.marina_price_tier (id, owner_id, valid_from, valid_to, max_len_m, price_per_night, created_at) VALUES
  (1, '${FOX}', '2026-06-01T00:00:00.000+01:00', '2026-09-30T00:00:00.000+01:00', 15, 50, '2026-04-01T10:00:00Z');
INSERT INTO sidon_fixture.berth_booking (id, owner_id, berth_id, sailor_name, sailor_email, boat_name, arrival_date, departure_date, status, amount_cents, expires_at, created_at, updated_at) VALUES
  (2, '${FOX}', 'A1', '${SAILOR}', '${EMAIL}', 'Fixture Boat', '2026-07-01', '2026-07-05', 'confirmed', 20000, NULL, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z'),
  (1, '${FOX}', 'A1', '${SAILOR}', '${EMAIL}', 'Fixture Boat', '2026-06-01', '2026-06-03', 'pending', NULL, '2026-05-02T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'),
  (3, '${AMB}', 'S1', '${SAILOR}', '${EMAIL}', 'Fixture Boat', '2026-06-10', '2026-06-12', 'cancelled', NULL, NULL, '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z');
INSERT INTO sidon_fixture.marina_doc_requirement (owner_id, type, name, schema, mandatory) VALUES ('${FOX}', 'insurance', 'Insurance', '[]', 1);
INSERT INTO sidon_fixture.marina_document (owner_id, requirement_id, booking_id, status, submitted_at, type, file_url, file_name) VALUES
  ('${FOX}', 1, 2, 'verified', '2026-06-20T00:00:00Z', 'insurance', 'https://x.public.blob.vercel-storage.com/sailor-docs/u/1.pdf', 'ins.pdf');
INSERT INTO sidon_fixture.marina_contract_template (owner_id, name, body_markdown, active, created_at) VALUES ('${FOX}', 'Contract', 'I, {{sailor_name}}', 1, '2026-04-03T00:00:00Z');
INSERT INTO sidon_fixture.marina_contract_signature (owner_id, template_id, booking_id, rendered_body, signed_at) VALUES ('${FOX}', 1, 2, 'I, ${SAILOR}', '2026-06-21T00:00:00Z');
INSERT INTO sidon_fixture.marina_poi (owner_id, label, type, lat, lng) VALUES ('${FOX}', 'Fuel dock', 'fuel', 41.11, 9.51);
INSERT INTO sidon_fixture.marina_image (owner_id, url, created_at) VALUES ('${FOX}', 'https://x.public.blob.vercel-storage.com/marina/f/1.webp', '2026-04-06T00:00:00Z');
INSERT INTO sidon_fixture.marina_message (owner_id, sailor_email, sailor_name, direction, body, created_at) VALUES
  ('${CHAT}', '${EMAIL}', '${SAILOR}', 'in', 'Hello', '2026-05-01T00:00:00Z');
`;

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query('BEGIN');
  let failed = 0;
  const check = async (name, fn) => {
    await db.query('SAVEPOINT c');
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
    // Every check starts from the same fixture: nothing one check inserts is seen by the next.
    await db.query('ROLLBACK TO SAVEPOINT c');
  };
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const fixture = () => I.readSource(db, 'sidon_fixture');
  let n = 0;
  const mapFile = (owners) => {
    const f = path.join(os.tmpdir(), `check-import-sidon-${process.pid}-${n++}.json`);
    fs.writeFileSync(f, JSON.stringify({ owners }));
    return f;
  };
  const plan = async (owners) => {
    const source = await fixture();
    const map = I.loadMap(mapFile(owners));
    return I.planMapping(source, map, await I.readTargets(db, source, map));
  };

  try {
    await db.query(FIXTURE_DDL);
    await db.query(FIXTURE_ROWS);
    const BBP = (await one(`INSERT INTO property (name, currency, timezone) VALUES ('Fixture BB', 'GBP', 'Pacific/Tahiti') RETURNING id`)).id;
    const SEA = { action: 'create', name: 'Fixture SEA', timezone: 'Europe/Rome', clerk_org_id: 'org_check_sea' };
    const baseMap = () => ({
      [FOX]: { ...SEA }, [PEV]: { ...SEA, slug: 'pevero-mooring' },
      [BB]: { action: 'property', property_id: BBP, currency_decision: 'drop_prices' },
      [GHOST]: { action: 'rekey', to_owner: I.alias(FOX) }, [I.alias(AMB)]: { action: 'skip', reason: 'ambiguous' }, // keyed by alias (G2)
    });

    await check('pure: alias and uid are deterministic and well-formed', async () => {
      assert.match(I.alias(FOX), /^o_[0-9a-f]{6}$/);
      assert.equal(I.alias(FOX), I.alias(FOX));
      const u = I.uid('booking', 42);
      assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.equal(u, I.uid('booking', 42));
      assert.notEqual(u, I.uid('document', 42));
      assert.equal((await one('SELECT $1::uuid::text AS u', [u])).u, u);
    });

    await check('pure: slugify, tierDate, cleanEmail', async () => {
      assert.equal(I.slugify('  Marina di Positano!! '), 'marina-di-positano');
      assert.equal(I.tierDate('2026-06-01T00:00:00.000+01:00'), '2026-06-01'); // not 2026-05-31 in a zone behind +01:00
      assert.equal(I.cleanEmail('  a@b.c '), 'a@b.c');
      for (const bad of ['', '   ', 'nobody', '@b.c', null]) assert.equal(I.cleanEmail(bad), null);
    });

    await check('pure: mapBookingStatus edges (Review Focus 3)', async () => {
      const now = new Date('2026-10-12T12:00:00Z');
      const today = '2026-10-12';
      const b = (status, expires_at, departure_date = '2026-11-01') => I.mapBookingStatus({ status, expires_at, departure_date }, today, now);
      const expired = { status: 'cancelled', cancel_reason: 'expired' };
      assert.deepEqual(b('pending', new Date(now)), expired);                               // expires exactly now
      assert.deepEqual(b('pending', null), expired);
      assert.deepEqual(b('pending', new Date('2026-10-20T00:00:00Z'), '2026-10-11'), expired); // departed
      assert.deepEqual(b('pending', new Date('2026-10-20T00:00:00Z'), today), { status: 'pending', cancel_reason: null }); // departs today
      assert.deepEqual(b('confirmed', null, '2026-01-01'), { status: 'confirmed', cancel_reason: null });
      assert.equal(b('paid', null), null);
    });

    await check('pure: insideRetention 90-day boundary (Review Focus 3)', async () => {
      const now = new Date('2026-10-12T12:00:00Z');
      const today = '2026-10-12';
      const r = (status, departure, updated_at = now) => I.insideRetention({ status, departure, updated_at }, today, now);
      assert.equal(r('confirmed', '2026-07-14'), true);   // today - 90
      assert.equal(r('confirmed', '2026-07-13'), false);  // today - 91
      assert.equal(r('confirmed', null), true);           // open-ended
      assert.equal(r('cancelled', '2026-12-01', new Date(now.getTime() - 90 * 864e5)), true);
      assert.equal(r('declined', '2026-12-01', new Date(now.getTime() - 90 * 864e5 - 1000)), false);
      assert.equal(r('pending', '2026-12-01', new Date('2020-01-01')), true);
    });

    await check('loadMap refuses bad files, reprice and create without clerk_org_id', async () => {
      const bad = path.join(os.tmpdir(), `check-import-sidon-${process.pid}-bad.json`);
      fs.writeFileSync(bad, '{not json');
      assert.throws(() => I.loadMap(bad), I.ImportRefused);
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'property', property_id: BBP, currency_decision: 'reprice' } })), /reprice/);
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'create', name: 'X', timezone: 'Europe/Rome' } })), /clerk_org_id/);
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'merge' } })), /unknown action/);
      assert.equal(I.loadMap(mapFile(baseMap())).owners[BB].property_id, BBP);
    });

    await check('readSource reads exactly the Source columns, bookings by created_at', async () => {
      await assert.rejects(I.readSource(db, 'x; drop'), I.ImportRefused);
      const s = await fixture();
      assert.deepEqual(Object.keys(s.profiles[0]), ['owner_id', 'slug', 'name', 'lat', 'lng', 'description', 'phone', 'email', 'website', 'response_window_hours', 'currency', 'updated_at']);
      assert.deepEqual(Object.keys(s.bookings[0]), ['id', 'owner_id', 'berth_id', 'sailor_name', 'sailor_email', 'boat_name', 'boat_loa', 'boat_beam', 'arrival_date', 'departure_date', 'notes', 'status', 'payment_intent_id', 'amount_cents', 'expires_at', 'created_at', 'updated_at']);
      assert.deepEqual(s.bookings.map((b) => b.id), [1, 2, 3]);
      assert.equal(s.tiers[0].valid_from, '2026-06-01T00:00:00.000+01:00');
      assert.deepEqual(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length])),
        { profiles: 3, layouts: 1, overlays: 1, berths: 5, tiers: 1, bookings: 3, requirements: 1, documents: 1, templates: 1, signatures: 1, pois: 1, images: 1, messages: 1 });
    });

    await check('plan: FOX + PEV share one created property, map order, alias keys (G1, G2)', async () => {
      const p = await plan(baseMap());
      assert.deepEqual(p.refusals, []);
      const sea = p.properties.find((x) => x.create);
      assert.deepEqual(sea, { key: 'create:org_check_sea:Fixture SEA', property_id: null,
        create: { name: 'Fixture SEA', timezone: 'Europe/Rome', clerk_org_id: 'org_check_sea', currency: 'EUR' }, currency: 'EUR', owners: [FOX, PEV] });
      const by = Object.fromEntries(p.owners.map((o) => [o.owner_id, o]));
      assert.equal(by[FOX].slug, 'fox-mooring');
      assert.equal(by[PEV].slug, 'pevero-mooring');
      assert.equal(by[GHOST].action, 'rekey');
      assert.equal(by[GHOST].rekey_to, FOX);
      assert.deepEqual([by[AMB].action, by[AMB].reason], ['skip', 'ambiguous']);
      assert.deepEqual([by[CHAT].action, by[CHAT].reason], ['skip', 'no child rows']); // G13
    });

    await check('plan: currency of a reused property differs -> flagged; refused without a decision (Review Focus 1)', async () => {
      const ok = await plan(baseMap());
      assert.deepEqual(ok.currencyFlags, [{ alias: I.alias(BB), marina_currency: 'EUR', property_currency: 'GBP', decision: 'drop_prices' }]);
      assert.equal(ok.owners.find((o) => o.owner_id === BB).prices, 'drop');
      const m = baseMap();
      delete m[BB].currency_decision;
      const p = await plan(m);
      assert.equal(p.refusals.length, 1);
      assert.match(p.refusals[0], new RegExp(`^${I.alias(BB)}: marina currency EUR differs from property currency GBP`));
    });

    await check('plan: refusals (tz mismatch, absent owner with rows, profile-less import, bad rekey, slugs)', async () => {
      const r = async (edit) => { const m = baseMap(); edit(m); return (await plan(m)).refusals.join(' | '); };
      assert.match(await r((m) => { m[PEV].timezone = 'Europe/London'; }), /timezone\/currency differ/);
      assert.match(await r((m) => { delete m[I.alias(AMB)]; }), new RegExp(`${I.alias(AMB)} is not in the map and has rows`));
      assert.match(await r((m) => { m[GHOST] = { ...SEA, clerk_org_id: 'org_x' }; }), /has no marina profile/);
      assert.match(await r((m) => { m[GHOST] = { action: 'rekey', to_owner: AMB }; }), /is not an importing owner/);
      assert.match(await r((m) => { m[PEV].slug = 'fox-mooring'; }), /both use slug "fox-mooring"/);
      assert.match(await r((m) => { m[PEV].slug = 'Bad Slug'; }), /is not a valid slug/);
      assert.match(await r((m) => { m[BB].property_id = '00000000-0000-0000-0000-000000000000'; }), /not found on the target/);
      assert.match(await r((m) => { m.o_ffffff = { action: 'skip', reason: 'x' }; }), /o_ffffff matches no Sidon owner/);
    });

    await check('plan: re-key suggestions for profile-less owners', async () => {
      const p = await plan(baseMap());
      const byAlias = (a, b) => a.alias.localeCompare(b.alias);
      assert.deepEqual([...p.suggestions].sort(byAlias), [
        { alias: I.alias(AMB), rekey_to_alias: null },        // its S1 is in FOX and PEV
        { alias: I.alias(GHOST), rekey_to_alias: I.alias(FOX) }, // FOX's overlay and FOX-only label
      ].sort(byAlias));
    });

    await check('readTargets: a re-run finds the created property via marina.sidon_owner_id, then property.sidon_marina_id', async () => {
      const P = (await one(`INSERT INTO property (name, currency, timezone, sidon_marina_id) VALUES ('Fixture SEA', 'EUR', 'Europe/Rome', $1) RETURNING id`, [FOX])).id;
      let p = await plan(baseMap());
      assert.equal(p.properties.find((x) => x.key.startsWith('create:')).property_id, P);
      assert.equal(p.properties.find((x) => x.key.startsWith('create:')).create, null);
      await db.query(`UPDATE property SET sidon_marina_id = NULL WHERE id = $1`, [P]);
      await db.query(`INSERT INTO marina (property_id, name, slug, sidon_owner_id) VALUES ($1, 'Pevero', 'pevero-mooring', $2)`, [P, PEV]);
      p = await plan(baseMap());
      assert.equal(p.properties.find((x) => x.key.startsWith('create:')).property_id, P);
    });

    await check('formatPlan: aliases, slugs and map names only (Review Focus 4)', async () => {
      const m = baseMap();
      delete m[BB].currency_decision;
      const text = I.formatPlan(await plan(m));
      assert.match(text, /create "Fixture SEA" \(EUR, Europe\/Rome\)/);
      assert.match(text, new RegExp(`${I.alias(GHOST)}: suggest rekey -> ${I.alias(FOX)}`));
      assert.match(text, /refusals:/);
      for (const secret of [FOX, PEV, BB, GHOST, CHAT, AMB, EMAIL, 'office.fixture@example.com', SAILOR, GUEST]) assert.ok(!text.includes(secret), `formatPlan leaks ${secret}`);
    });

    // (later tasks append checks here)
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
