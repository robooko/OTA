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
      assert.throws(() => I.loadMap(mapFile({ [FOX]: { action: 'create', name: 'X', timezone: 'Europe/Rome', clerk_org_id: '' } })), /clerk_org_id/);
      assert.equal(I.loadMap(mapFile({ [FOX]: { action: 'create', name: 'X', timezone: 'Europe/Rome', clerk_org_id: null } })).owners[FOX].clerk_org_id, null);
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

    // ── Properties, catalogue and the re-run guard ──
    // Three owners of our own, held in memory (readSource is pinned by the
    // fixture checks above): A is created, B reuses a GBP property while its
    // Sidon marina is eur, and G is profile-less and re-keyed to A. Each run
    // re-reads targets and re-plans, as the CLI does.
    {
      const I = require('./import-sidon-marina');
      const { STARTER_BALANCE } = require('../src/lib/tokens');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const rows = async (sql, params) => (await db.query(sql, params)).rows;
      const A = 'org_t2_alpha', B = 'org_t2_beta', G = 'user_t2_ghost';
      const at = (s) => new Date(s);
      const REQ_FIELDS = [{ name: 'policy_number', label: 'Policy number', type: 'string' }];
      const berth = (id, owner_id, label, overlay_id, status, extra = {}) => ({
        id, owner_id, berth_id: label, overlay_id, lat: null, lng: null, length_m: 12, min_length_m: null, beam_m: 4, depth_m: 3,
        status, guest_name: null, notes: '', price_per_night: 5, price_mode: 'per_metre', rotation: null, ...extra,
      });
      const SRC = {
        profiles: [
          { owner_id: A, slug: 't2-alpha', name: 'Alpha Check', lat: 41.1, lng: 9.5, description: '', phone: '', email: '', website: null,
            response_window_hours: null, currency: 'eur', updated_at: at('2026-08-01T00:00:00Z') },
          { owner_id: B, slug: 't2-beta', name: 'Beta Check', lat: -16.5, lng: -151.7, description: 'Lagoon moorings', phone: null, email: null, website: null,
            response_window_hours: 48, currency: 'eur', updated_at: at('2026-08-01T00:00:00Z') },
        ],
        layouts: [{ owner_id: A, svg_data: '<svg viewBox="0 0 10 10"/>', sw_lat: 41.0, sw_lng: 9.4, ne_lat: 41.2, ne_lng: 9.6, rotation: 12.5 }],
        overlays: [
          { id: 9101, owner_id: A, name: 'Pontoon A', svg_data: '<path/>', sw_lat: 41.0, sw_lng: 9.4, ne_lat: 41.1, ne_lng: 9.5, rotation: 0, sort_order: null },
          { id: 9102, owner_id: B, name: 'Pontoon B', svg_data: null, sw_lat: null, sw_lng: null, ne_lat: null, ne_lng: null, rotation: null, sort_order: 2 },
        ],
        berths: [
          berth(9201, A, 'A1', 9101, 'available', { length_m: 12.199999809265137 }), // float4 noise -> 12.20
          berth(9202, A, 'A2', 9102, 'occupied', { price_mode: null }),            // B's overlay: cross-owner, counted
          berth(9203, A, 'A3', 9999, 'maintenance', { price_per_night: null, price_mode: 'fixed' }), // dangling overlay
          berth(9204, G, 'A1', 9101, 'available'),                                 // re-keyed duplicate of A1
          berth(9205, G, 'G9', null, 'reserved'),                                  // re-keyed, new label
          berth(9206, B, 'B1', 9102, 'available', { price_per_night: 80, price_mode: 'fixed' }),
        ],
        tiers: [
          { id: 9301, owner_id: A, valid_from: '2026-06-01T00:00:00.000+01:00', valid_to: '2026-09-30T00:00:00.000+01:00', max_len_m: 15.5, max_beam_m: null,
            price_per_night: 50, price_per_month: 1200, price_per_year: null, created_at: at('2026-04-01T10:00:00Z') },
          { id: 9302, owner_id: B, valid_from: '2026-05-01T00:00:00.000+01:00', valid_to: '2026-10-31T00:00:00.000+01:00', max_len_m: 20, max_beam_m: 6,
            price_per_night: 70, price_per_month: null, price_per_year: null, created_at: at('2026-04-02T10:00:00Z') },
        ],
        bookings: [],
        requirements: [
          { id: 9401, owner_id: A, type: 'insurance', name: 'Insurance', description: '', schema: JSON.stringify(REQ_FIELDS), mandatory: 1, sort_order: null },
          { id: 9402, owner_id: G, type: 'insurance', name: 'Insurance (old)', description: null, schema: '[]', mandatory: 1, sort_order: 1 },
          { id: 9403, owner_id: G, type: 'passport', name: 'Passport', description: null, schema: '[]', mandatory: 0, sort_order: 2 },
        ],
        documents: [],
        templates: [
          { id: 9501, owner_id: A, name: 'Berth contract', body_markdown: 'I, {{sailor_name}}, insured under {{acord25.policy_number}}', min_nights: null, active: 1, created_at: at('2026-04-03T10:00:00Z') },
          { id: 9502, owner_id: G, name: 'Old contract', body_markdown: 'Old', min_nights: 0, active: 1, created_at: at('2026-04-04T10:00:00Z') },
          { id: 9503, owner_id: B, name: 'Draft contract', body_markdown: 'Draft for {{boat_name}}', min_nights: 4, active: 0, created_at: at('2026-04-05T10:00:00Z') },
        ],
        signatures: [],
        pois: [{ id: 9601, owner_id: A, label: 'Fuel dock', type: 'fuel', lat: 41.11, lng: 9.51 }],
        images: [{ id: 9701, owner_id: A, url: 'https://sidon.example/marina/a/1.webp', description: null, sort_order: null, created_at: at('2026-04-06T10:00:00Z') }],
        messages: [],
      };
      const MAP_FILE = path.join(os.tmpdir(), 'check-import-sidon-t2.json');
      const run = async (P, mode = 'commit', decision = 'drop_prices') => {
        fs.writeFileSync(MAP_FILE, JSON.stringify({ owners: {
          [A]: { action: 'create', name: 'T2 Alpha Co', timezone: 'Europe/Rome', clerk_org_id: 'org_check_t2' },
          [B]: { action: 'property', property_id: P, currency_decision: decision },
          [G]: { action: 'rekey', to_owner: A },
        } }));
        const map = I.loadMap(MAP_FILE);
        const plan = I.planMapping(SRC, map, await I.readTargets(db, SRC, map));
        return I.importSidon(db, SRC, plan, { mode, target: 'local', files: false });
      };
      // B's property: GBP behind UTC, with an interim sidon_marina_id that must survive (G3).
      const beta = async () => (await rows(
        `INSERT INTO property (name, currency, timezone, sidon_marina_id) VALUES ('T2 Beta Check', 'GBP', 'Pacific/Tahiti', 'org_t2_interim') RETURNING id`))[0].id;
      const todayIn = async (tz) => (await rows('SELECT (now() AT TIME ZONE $1)::date::text AS d', [tz]))[0].d;
      const MA = I.uid('marina', A), MB = I.uid('marina', B);
      const starterRows = STARTER_BALANCE > 0 ? [{ delta: STARTER_BALANCE, balance_after: STARTER_BALANCE, reason: 'starter' }] : [];

      await check('import: created property has the map fields, an enabled prop_ key, sidon_marina_id = first owner, one starter grant', async () => {
        const report = await run(await beta());
        const created = report.properties.filter((p) => p.created);
        assert.equal(created.length, 1);
        const [p] = await rows('SELECT * FROM property WHERE id = $1', [created[0].property_id]);
        assert.deepEqual([p.name, p.currency, p.timezone, p.clerk_org_id, p.sidon_marina_id, p.api_key_enabled],
          ['T2 Alpha Co', 'EUR', 'Europe/Rome', 'org_check_t2', A, true]);
        assert.match(p.api_key, /^prop_[0-9a-f]{64}$/);
        assert.equal(p.token_balance, STARTER_BALANCE > 0 ? STARTER_BALANCE : 0);
        assert.deepEqual(await rows('SELECT delta, balance_after, reason FROM property_token_ledger WHERE property_id = $1', [p.id]), starterRows);
        assert.equal(created[0].today, await todayIn('Europe/Rome'));
      });

      await check('import: a reused property is never written (currency, timezone, sidon_marina_id, tokens; G3)', async () => {
        const P = await beta();
        const snap = async () => (await rows('SELECT currency, timezone, sidon_marina_id, token_balance, api_key FROM property WHERE id = $1', [P]))[0];
        const before = await snap();
        const report = await run(P);
        assert.deepEqual(await snap(), before);
        assert.deepEqual(await rows('SELECT id FROM property_token_ledger WHERE property_id = $1', [P]), []);
        assert.deepEqual(report.properties.find((p) => p.property_id === P), { key: P, property_id: P, created: false, today: await todayIn('Pacific/Tahiti') });
        assert.deepEqual(report.currencyFlags.map((f) => [f.alias, f.decision]), [[I.alias(B), 'drop_prices']]);
      });

      await check('import: marina, pontoons, berths, tiers, requirements, templates, POIs and images map field by field', async () => {
        const report = await run(await beta(), 'commit', 'accept_as_property_currency');
        const PA = report.properties.find((p) => p.created).property_id;
        const [m] = await rows('SELECT * FROM marina WHERE id = $1', [MA]);
        assert.deepEqual(
          [m.property_id, m.sidon_owner_id, m.name, m.slug, m.description, m.phone, m.email, m.website, m.layout_svg, m.layout_rotation, m.response_window_hours, m.status],
          [PA, A, 'Alpha Check', 't2-alpha', null, null, null, null, '<svg viewBox="0 0 10 10"/>', 12.5, 24, 'active']);
        assert.equal((await rows('SELECT response_window_hours FROM marina WHERE id = $1', [MB]))[0].response_window_hours, 48);
        assert.deepEqual(await rows('SELECT id, name, sort_order FROM marina_pontoon WHERE marina_id = ANY($1) ORDER BY sort_order', [[MA, MB]]),
          [{ id: I.uid('pontoon', 9101), name: 'Pontoon A', sort_order: 0 }, { id: I.uid('pontoon', 9102), name: 'Pontoon B', sort_order: 2 }]);
        const berths = await rows('SELECT id, pontoon_id, label, length_m, price_per_night, price_mode, notes, status FROM marina_berth WHERE marina_id = $1 ORDER BY label', [MA]);
        assert.deepEqual(berths.map((b) => Object.values(b)), [
          [I.uid('berth', 9201), I.uid('pontoon', 9101), 'A1', '12.20', '5.00', 'per_metre', null, 'active'],
          [I.uid('berth', 9202), null, 'A2', '12.00', '5.00', 'per_metre', null, 'active'],
          [I.uid('berth', 9203), null, 'A3', '12.00', null, 'fixed', null, 'maintenance'],
          [I.uid('berth', 9205), null, 'G9', '12.00', '5.00', 'per_metre', null, 'active'],
        ]);
        assert.deepEqual(await rows(
          `SELECT id, valid_from, valid_to, max_length_m, max_beam_m, price_per_night, price_per_month, price_per_year, created_at
           FROM marina_price_tier WHERE marina_id = $1`, [MA]),
        [{ id: I.uid('tier', 9301), valid_from: '2026-06-01', valid_to: '2026-09-30', max_length_m: '15.50', max_beam_m: null,
          price_per_night: '50.00', price_per_month: '1200.00', price_per_year: null, created_at: at('2026-04-01T10:00:00Z') }]);
        assert.deepEqual(await rows('SELECT id, type, name, description, fields, mandatory, sort_order FROM marina_doc_requirement WHERE marina_id = $1 ORDER BY sort_order', [MA]), [
          { id: I.uid('requirement', 9401), type: 'insurance', name: 'Insurance', description: null, fields: REQ_FIELDS, mandatory: true, sort_order: 0 },
          { id: I.uid('requirement', 9403), type: 'passport', name: 'Passport', description: null, fields: [], mandatory: false, sort_order: 2 },
        ]);
        assert.deepEqual(await rows('SELECT id, marina_id, status, min_nights, created_at FROM marina_contract_template WHERE marina_id = ANY($1) ORDER BY min_nights', [[MA, MB]]), [
          { id: I.uid('template', 9501), marina_id: MA, status: 'active', min_nights: 0, created_at: at('2026-04-03T10:00:00Z') },
          { id: I.uid('template', 9503), marina_id: MB, status: 'inactive', min_nights: 4, created_at: at('2026-04-05T10:00:00Z') },
        ]);
        assert.deepEqual(report.unknownPlaceholders, [{ alias: I.alias(A), template_id: I.uid('template', 9501), fields: ['acord25.policy_number'] }]);
        assert.deepEqual(await rows('SELECT id, label, type, lat, lng FROM marina_poi WHERE marina_id = $1', [MA]),
          [{ id: I.uid('poi', 9601), label: 'Fuel dock', type: 'fuel', lat: 41.11, lng: 9.51 }]);
        assert.deepEqual(await rows('SELECT id, url, description, sort_order, created_at FROM marina_image WHERE marina_id = $1', [MA]),
          [{ id: I.uid('image', 9701), url: 'https://sidon.example/marina/a/1.webp', description: null, sort_order: 0, created_at: at('2026-04-06T10:00:00Z') }]);
      });

      await check('import: re-key drops duplicate labels (counted), cross-owner overlay -> pontoon NULL (counted), dangling overlay -> NULL', async () => {
        const report = await run(await beta());
        const a = report.marinas.find((m) => m.alias === I.alias(A)).counts;
        assert.deepEqual(
          [a.pontoons, a.berths, a.berths_duplicate, a.pontoon_nulled, a.tiers, a.requirements, a.templates, a.pois, a.images],
          [1, 4, 1, 1, 1, 2, 1, 1, 1]);
        assert.deepEqual(report.rekeys, [{ alias: I.alias(G), to_alias: I.alias(A) }]);
        assert.equal(report.marinas.some((m) => m.alias === I.alias(G)), false);
        assert.deepEqual(await rows('SELECT id FROM marina_berth WHERE id = $1', [I.uid('berth', 9204)]), []);
      });

      await check('import: drop_prices -> NULL berth prices and no tiers; accept_as_property_currency keeps them (Review Focus 1)', async () => {
        const P = await beta();
        const priced = async () => ({
          berth: (await rows("SELECT price_per_night FROM marina_berth WHERE marina_id = $1 AND label = 'B1'", [MB]))[0].price_per_night,
          tiers: (await rows('SELECT price_per_night FROM marina_price_tier WHERE marina_id = $1', [MB])).map((t) => t.price_per_night),
        });
        const dropped = await run(P, 'commit', 'drop_prices');
        assert.deepEqual(await priced(), { berth: null, tiers: [] });
        assert.equal(dropped.marinas.find((m) => m.alias === I.alias(B)).counts.tiers, 0);
        await run(P, 'commit', 'accept_as_property_currency');
        assert.deepEqual(await priced(), { berth: '80.00', tiers: ['70.00'] });
      });

      await check('import: a second run keeps marina/berth/tier ids, counts and the created property; report has aliases only (Review Focus 2)', async () => {
        const P = await beta();
        const snapshot = async () => ({
          marinas: await rows('SELECT id, property_id FROM marina WHERE sidon_owner_id = ANY($1) ORDER BY id', [[A, B]]),
          berths: (await rows('SELECT b.id FROM marina_berth b JOIN marina m ON m.id = b.marina_id WHERE m.sidon_owner_id = ANY($1) ORDER BY b.id', [[A, B]])).map((r) => r.id),
          tiers: (await rows('SELECT t.id FROM marina_price_tier t JOIN marina m ON m.id = t.marina_id WHERE m.sidon_owner_id = ANY($1) ORDER BY t.id', [[A, B]])).map((r) => r.id),
          properties: (await rows("SELECT id FROM property WHERE clerk_org_id = 'org_check_t2'")).map((r) => r.id),
        });
        const first = await run(P, 'commit', 'accept_as_property_currency');
        const s1 = await snapshot();
        const second = await run(P, 'commit', 'accept_as_property_currency');
        assert.deepEqual(await snapshot(), s1);
        assert.equal(s1.properties.length, 1);
        assert.equal(s1.berths.length, 5);
        assert.deepEqual(second.marinas, first.marinas);
        assert.deepEqual(second.properties.map((p) => [p.property_id, p.created]), first.properties.map((p) => [p.property_id, false]));
        assert.deepEqual(await rows('SELECT delta, balance_after, reason FROM property_token_ledger WHERE property_id = $1', [s1.properties[0]]), starterRows);
        const text = I.formatReport(second);
        for (const s of [A, B, G, 'Alpha Check', 'Beta Check', 'org_check_t2']) assert.equal(text.includes(s), false, `report leaks ${s}`);
        assert.ok(text.includes(I.alias(A)) && text.includes('t2-alpha'));
      });

      await check('import: a guest booking on an imported marina refuses a commit run (row kept), a dry run warns (Review Focus 2)', async () => {
        const P = await beta();
        await run(P);
        const [{ id: g }] = await rows(
          `INSERT INTO marina_booking (property_id, marina_id, berth_id, contact_name, arrival, departure, status, source)
           SELECT property_id, marina_id, id, 'Guest Check', '2027-06-01', '2027-06-03', 'confirmed', 'guest' FROM marina_berth WHERE id = $1 RETURNING id`,
          [I.uid('berth', 9201)]);
        await assert.rejects(run(P), (e) => e instanceof I.ImportRefused && e.message.includes(I.alias(A)) && /Switch/.test(e.message));
        assert.equal((await rows('SELECT id FROM marina_booking WHERE id = $1', [g])).length, 1);
        const dry = await run(P, 'dry-run');
        assert.equal(dry.warnings.filter((w) => w.includes(I.alias(A)) && /Switch/.test(w)).length, 1);
      });

      await check('import: an enquiry on an imported marina refuses a commit run (row kept), a dry run warns and unlinks it (Review Focus 2)', async () => {
        const P = await beta();
        const PA = (await run(P)).properties.find((p) => p.created).property_id;
        const [{ id: e }] = await rows(
          `INSERT INTO event_inquiry (property_id, name, email, marina_id) VALUES ($1, 'Enquiry Check', 'enquiry@example.com', $2) RETURNING id`, [PA, MA]);
        await assert.rejects(run(P), (err) => err instanceof I.ImportRefused && err.message.includes(I.alias(A)));
        assert.equal((await rows('SELECT marina_id FROM event_inquiry WHERE id = $1', [e]))[0].marina_id, MA);
        const dry = await run(P, 'dry-run');
        assert.ok(dry.warnings.some((w) => w.includes(I.alias(A)) && /enquir/.test(w)));
        assert.equal((await rows('SELECT marina_id FROM event_inquiry WHERE id = $1', [e]))[0].marina_id, null);
        assert.equal((await rows('SELECT id FROM marina WHERE id = $1', [MA])).length, 1);
      });

      fs.rmSync(MAP_FILE, { force: true });
    }

    // ---- Task 3: bookings, occupancy, signatures (R13, R15, R16) ----
    // Block-scoped so these names never collide with earlier tasks' helpers.
    // In-memory Source objects (the exact readSource shape) keep these cases
    // independent of the shared sidon_fixture rows.
    {
      const I = require('./import-sidon-marina');
      const { propertyToday } = require('../src/lib/marinaQueries');
      const { emailKey } = require('../src/lib/spaBookingGuard');
      const { bookingToken } = require('../src/lib/marinaToken');
      const OA = 'org_t3_alpha';    // created property in Pacific/Tahiti (UTC-10, like BBYC)
      const OR = 'org_t3_rekey';    // profile-less, re-keyed onto OA
      const OB = 'org_t3_sterling'; // reuses a GBP property with a eur profile
      const TZ = 'Pacific/Tahiti';
      const hour = 3600 * 1000;
      // Days relative to the Tahiti property's own today (now() is fixed for
      // the whole transaction), so "covers today" holds at any UTC hour.
      const day = async (offset) => (await db.query(
        'SELECT ((now() AT TIME ZONE $1)::date + $2::int)::text AS d', [TZ, offset])).rows[0].d;
      const empty = () => ({ profiles: [], layouts: [], overlays: [], berths: [], tiers: [], bookings: [], requirements: [],
        documents: [], templates: [], signatures: [], pois: [], images: [], messages: [] });
      const profile = (owner_id, slug, currency) => ({ owner_id, slug, name: slug, lat: null, lng: null, description: null,
        phone: null, email: null, website: null, response_window_hours: null, currency, updated_at: new Date('2026-01-01T00:00:00Z') });
      const berth = (id, owner_id, label, status, guest_name = null) => ({ id, owner_id, berth_id: label, overlay_id: null,
        lat: null, lng: null, length_m: 12, min_length_m: null, beam_m: 4, depth_m: null, status, guest_name, notes: null,
        price_per_night: 3, price_mode: 'per_metre', rotation: null });
      let seq = 0;
      // Source.bookings is in created_at, id order: each call is one second later.
      const booking = (id, owner_id, label, arrival, departure, status, extra = {}) => {
        const at = new Date(Date.UTC(2026, 2, 1, 0, 0, seq++));
        return { id, owner_id, berth_id: label, sailor_name: `Sailor ${id}`, sailor_email: `sailor${id}@example.com`,
          boat_name: `Boat ${id}`, boat_loa: 10, boat_beam: 3.5, arrival_date: arrival, departure_date: departure, notes: null,
          status, payment_intent_id: null, amount_cents: 10000, expires_at: null, created_at: at, updated_at: at, ...extra };
      };
      const alphaSource = async () => {
        seq = 0;
        const s = empty();
        s.profiles.push(profile(OA, 't3-alpha', 'eur'));
        s.berths.push(berth(9301, OA, 'A1', 'available'), berth(9302, OA, 'A2', 'available'),
          berth(9303, OA, 'A3', 'occupied', '  Capt Nemo  '), berth(9304, OA, 'A4', 'reserved', '   '),
          berth(9305, OA, 'A5', 'occupied'), berth(9306, OA, 'A6', 'occupied'),
          berth(9311, OR, 'A1', 'occupied'));
        s.bookings.push(
          booking(9401, OA, 'A1', '2030-06-01', '2030-06-05', 'confirmed', { sailor_email: '  Sailor.One+x@Example.com ',
            boat_loa: 12.346, boat_beam: 4.004, amount_cents: 12345, payment_intent_id: 'pi_t3_1', notes: 'n1' }),
          booking(9402, OA, 'A1', '2030-06-03', '2030-06-07', 'confirmed'),
          booking(9403, OA, 'Z9', '2030-06-01', '2030-06-03', 'confirmed'),
          booking(9404, OA, 'A2', '2030-07-01', '2030-07-05', 'pending', { expires_at: new Date(Date.now() - hour) }),
          booking(9405, OA, 'A2', '2030-07-10', '2030-07-12', 'pending'),
          booking(9406, OA, 'A2', '2030-08-01', '2030-08-03', 'pending', { expires_at: new Date(Date.now() + 24 * hour) }),
          booking(9407, OA, 'A2', '2030-09-01', '2030-09-03', 'declined', { sailor_email: 'no-at-sign' }),
          booking(9408, OA, 'A2', '2030-09-01', '2030-09-03', 'cancelled', { sailor_email: '   ' }),
          booking(9409, OA, 'A5', await day(-2), await day(3), 'confirmed'),
          booking(9410, OA, 'A6', await day(10), await day(12), 'confirmed'),
          booking(9411, OR, 'A1', '2031-01-10', '2031-01-12', 'confirmed'));
        s.templates.push({ id: 9601, owner_id: OA, name: 'T3 terms', body_markdown: 'I agree to the marina terms.',
          min_nights: 0, active: 1, created_at: new Date('2026-01-01T00:00:00Z') });
        s.signatures.push(
          { id: 9501, owner_id: OA, template_id: 9601, booking_id: 9401, rendered_body: 'Signed 9401',
            signed_at: new Date('2026-03-02T10:00:00Z'), ip_address: '203.0.113.7', user_agent: 'UA' },
          { id: 9502, owner_id: OA, template_id: 9601, booking_id: 9402, rendered_body: 'Signed 9402',
            signed_at: new Date('2026-03-02T11:00:00Z'), ip_address: null, user_agent: null },
          { id: 9503, owner_id: OR, template_id: 9699, booking_id: 9411, rendered_body: 'Signed 9411',
            signed_at: new Date('2026-03-02T12:00:00Z'), ip_address: null, user_agent: null });
        return s;
      };
      const alphaMap = { owners: {
        [OA]: { action: 'create', name: 'T3 Alpha', timezone: TZ, clerk_org_id: 'org_t3_check' },
        [OR]: { action: 'rekey', to_owner: OA },
      } };
      // Fresh readTargets + planMapping per run, so a second run finds the
      // first run's created property through Targets.reruns.
      const run = async (source, map) => {
        const targets = await I.readTargets(db, source, map);
        return I.importSidon(db, source, I.planMapping(source, map, targets), { mode: 'commit', target: 'local', files: false });
      };
      const countsOf = (report, ownerId) => report.marinas.find((m) => m.alias === I.alias(ownerId)).counts;
      const mb = async (kind, id) => (await db.query('SELECT * FROM marina_booking WHERE id = $1', [I.uid(kind, id)])).rows[0];
      const alpha = async () => countsOf(await run(await alphaSource(), alphaMap), OA);

      await check('T3: expired or expiry-less pending -> cancelled/expired; declined, cancelled, live pending as-is', async () => {
        const c = await alpha();
        const st = async (id) => { const r = await mb('booking', id); return [r.status, r.cancel_reason]; };
        assert.deepEqual(await st(9401), ['confirmed', null]);
        assert.deepEqual(await st(9404), ['cancelled', 'expired']);
        assert.deepEqual(await st(9405), ['cancelled', 'expired']);
        assert.deepEqual(await st(9406), ['pending', null]);
        assert.deepEqual(await st(9407), ['declined', null]);
        assert.deepEqual(await st(9408), ['cancelled', null]);
        assert.equal(c.pending_expired, 2);
        assert.equal(c.bookings, 9); // 11 source rows minus the overlap and the berth-less one
      });
      await check('T3: imported booking fields (R15)', async () => {
        await alpha();
        const r = await mb('booking', 9401);
        const { property_id } = (await db.query('SELECT property_id FROM marina WHERE id = $1', [I.uid('marina', OA)])).rows[0];
        assert.deepEqual([r.property_id, r.marina_id, r.berth_id], [property_id, I.uid('marina', OA), I.uid('berth', 9301)]);
        assert.deepEqual([r.arrival, r.departure], ['2030-06-01', '2030-06-05']);
        assert.deepEqual([r.source, r.locale, r.payment_status, r.hold_expires_at], ['import', 'en', 'none', null]);
        assert.equal(r.legacy_payment_intent_id, 'pi_t3_1');
        assert.deepEqual([r.total_price, r.currency], ['123.45', 'EUR']);
        assert.deepEqual([r.boat_length_m, r.boat_beam_m], ['12.35', '4.00']);
        assert.deepEqual([r.contact_name, r.boat_name, r.notes], ['Sailor 9401', 'Boat 9401', 'n1']);
        assert.equal(r.contact_email, 'Sailor.One+x@Example.com');
        assert.equal(r.contact_email_key, emailKey('Sailor.One+x@Example.com'));
        assert.equal(r.contact_email_key, 'sailor.one@example.com');
        assert.equal(r.created_at.getTime(), Date.UTC(2026, 2, 1, 0, 0, 0));
        assert.equal(r.updated_at.getTime(), Date.UTC(2026, 2, 1, 0, 0, 0));
      });
      await check('T3: blank or @-less emails import as NULL with a NULL key, and are counted', async () => {
        const c = await alpha();
        for (const id of [9407, 9408]) {
          const r = await mb('booking', id);
          assert.deepEqual([r.contact_email, r.contact_email_key], [null, null]);
        }
        assert.equal(c.emails_nulled, 2);
      });
      await check('T3: the later of an overlapping confirmed pair is skipped and counted', async () => {
        const c = await alpha();
        assert.ok(await mb('booking', 9401), 'the earlier one is kept');
        assert.equal(await mb('booking', 9402), undefined);
        assert.equal(c.bookings_overlap, 1);
      });
      await check('T3: a booking whose berth label is not in the target marina is skipped and counted', async () => {
        const c = await alpha();
        assert.equal(await mb('booking', 9403), undefined);
        assert.equal(c.bookings_no_berth, 1);
      });
      await check("T3 (R13): a re-keyed owner's booking lands on the target's berth, counted under the target", async () => {
        const c = await alpha();
        const r = await mb('booking', 9411);
        assert.deepEqual([r.marina_id, r.berth_id], [I.uid('marina', OA), I.uid('berth', 9301)]);
        assert.equal(c.bookings, 9);
      });
      const sterling = async (decision) => {
        const P = (await db.query(
          "INSERT INTO property (name, timezone, currency) VALUES ('T3 Sterling', 'Europe/London', 'GBP') RETURNING id")).rows[0].id;
        seq = 0;
        const s = empty();
        s.profiles.push(profile(OB, 't3-sterling', 'eur'));
        s.berths.push(berth(9321, OB, 'B1', 'available'));
        s.bookings.push(booking(9701, OB, 'B1', '2030-05-01', '2030-05-03', 'confirmed', { amount_cents: 5000 }));
        await run(s, { owners: { [OB]: { action: 'property', property_id: P, currency_decision: decision } } });
        return mb('booking', 9701);
      };
      await check('T3 (Review Focus 1): drop_prices -> the property currency and a NULL total', async () => {
        const r = await sterling('drop_prices');
        assert.deepEqual([r.currency, r.total_price], ['GBP', null]);
      });
      await check('T3 (Review Focus 1): accept_as_property_currency keeps the number, in the property currency', async () => {
        const r = await sterling('accept_as_property_currency');
        assert.deepEqual([r.currency, r.total_price], ['GBP', '50.00']);
      });
      await check("T3 (Review Focus 3): occupancy starts on the Tahiti property's today; blank guest -> Reserved", async () => {
        const c = await alpha();
        const occ = await mb('occupancy', 9303);
        const today = await propertyToday(db, occ.property_id);
        assert.equal(today, await day(0));
        assert.deepEqual([occ.arrival, occ.departure, occ.status, occ.source], [today, null, 'confirmed', 'import']);
        assert.deepEqual([occ.contact_name, occ.total_price, occ.currency, occ.payment_status], ['Capt Nemo', null, 'EUR', 'none']);
        assert.equal(occ.berth_id, I.uid('berth', 9303));
        assert.equal((await mb('occupancy', 9304)).contact_name, 'Reserved');
        assert.equal(await mb('occupancy', 9305), undefined, 'covered today by an imported booking');
        assert.equal(await mb('occupancy', 9306), undefined, 'a future booking blocks the open-ended row');
        assert.equal(await mb('occupancy', 9301), undefined, 'available berth');
        assert.equal(await mb('occupancy', 9311), undefined, 're-keyed duplicate berth is not imported');
        assert.deepEqual([c.occupancy, c.occupancy_overlap], [2, 1]);
      });
      await check('T3 (Review Focus 2): booking ids and bookingToken(id) are identical across two runs', async () => {
        const snapshot = async () => (await db.query(
          'SELECT id FROM marina_booking WHERE marina_id = $1 ORDER BY id', [I.uid('marina', OA)])).rows
          .map((r) => [r.id, bookingToken(r.id)]);
        const c1 = await alpha();
        const first = await snapshot();
        const c2 = await alpha();
        const second = await snapshot();
        assert.equal(first.length, 11); // 9 bookings + 2 occupancy rows
        assert.deepEqual(second, first);
        assert.deepEqual(c2, c1);
        assert.ok(first.some(([id]) => id === I.uid('booking', 9401)));
      });
      await check('T3: signatures exist only for imported bookings', async () => {
        const c = await alpha();
        const { rows } = await db.query(
          'SELECT * FROM marina_contract_signature WHERE booking_id = ANY($1) ORDER BY agreed_at',
          [[9401, 9402, 9403, 9411].map((id) => I.uid('booking', id))]);
        assert.deepEqual(rows.map((r) => r.id), [I.uid('signature', 9501), I.uid('signature', 9503)]);
        const [a, b] = rows;
        assert.deepEqual([a.booking_id, a.template_id, a.rendered_body, a.signer_email, a.ip_address, a.user_agent],
          [I.uid('booking', 9401), I.uid('template', 9601), 'Signed 9401', 'Sailor.One+x@Example.com', '203.0.113.7', 'UA']);
        assert.equal(a.agreed_at.getTime(), Date.parse('2026-03-02T10:00:00Z'));
        assert.equal(a.property_id, (await mb('booking', 9401)).property_id);
        assert.deepEqual([b.booking_id, b.template_id, b.signer_email], [I.uid('booking', 9411), null, 'sailor9411@example.com']);
        assert.equal(c.signatures, 2);
      });
    }
    // ---- Task 4: documents, images, archive, messages, report ----
    {
      const { alias, uid, readSource, readTargets, planMapping, importSidon, formatReport, sourcePath, extOf, typeFromExt } = require('./import-sidon-marina');
      const blobSeam = require('../src/lib/marinaDocuments');
      // Own source schema with sidon_fixture's exact column types, so these
      // documents don't disturb what the earlier checks count.
      const S = 'sidon_docs';
      const A = 'org_docsCheckA1';  // imported into a created property
      const SK = 'org_docsCheckS2'; // skipped: its marina-docs go to the archive
      const STORE = 'https://sidonstore.public.blob.vercel-storage.com/';
      const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      await db.query(`CREATE SCHEMA ${S}`);
      for (const t of ['marina_profile', 'marina_layout', 'marina_overlay', 'marina_berth', 'marina_price_tier', 'berth_booking',
        'marina_doc_requirement', 'marina_document', 'marina_contract_template', 'marina_contract_signature', 'marina_poi', 'marina_image', 'marina_message']) {
        await db.query(`CREATE TABLE ${S}.${t} (LIKE sidon_fixture.${t})`);
      }
      await db.query(
        `INSERT INTO ${S}.marina_profile (owner_id, slug, name, lat, lng, description, phone, email, website, response_window_hours, currency, updated_at)
         VALUES ($1, 'docs-check', 'Docs Check Harbour', 43.1, 9.5, '', '', 'harbour@docs-check.example', '', 24, 'eur', now()),
                ($2, 'docs-skip', 'Docs Skip Harbour', 43.2, 9.6, '', '', 'skip@docs-check.example', '', 24, 'eur', now())`, [A, SK]);
      await db.query(
        `INSERT INTO ${S}.marina_berth (id, owner_id, berth_id, overlay_id, lat, lng, length_m, min_length_m, beam_m, depth_m, status, guest_name, notes, price_per_night, price_mode, rotation)
         VALUES (1, $1, 'D1', NULL, 43.1, 9.5, 12, NULL, 4, 3, 'available', NULL, NULL, 50, 'fixed', 0),
                (2, $1, 'D2', NULL, 43.1, 9.5, 12, NULL, 4, 3, 'available', NULL, NULL, 50, 'fixed', 0),
                (3, $2, 'S1', NULL, 43.2, 9.6, 12, NULL, 4, 3, 'available', NULL, NULL, 50, 'fixed', 0)`, [A, SK]);
      // Booking 1 departs in a week (inside retention), booking 2 departed
      // 200 days ago (outside), booking 10 belongs to the skipped owner.
      await db.query(
        `INSERT INTO ${S}.berth_booking (id, owner_id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, notes, status, payment_intent_id, amount_cents, expires_at, created_at, updated_at)
         VALUES (1, $1, 'D1', 'Ann Sailor', 'ann.sailor@docs-check.example', 'Docs One', 10, 3.5, $3, $4, NULL, 'confirmed', NULL, 10000, NULL, now(), now()),
                (2, $1, 'D2', 'Bob Mariner', 'bob.mariner@docs-check.example', 'Docs Two', 10, 3.5, $5, $6, NULL, 'confirmed', NULL, 10000, NULL, now() - interval '210 days', now() - interval '200 days'),
                (10, $2, 'S1', 'Cy Skipper', 'cy.skipper@docs-check.example', 'Docs Skip', 10, 3.5, $3, $4, NULL, 'confirmed', NULL, 10000, NULL, now(), now())`,
        [A, SK, day(5), day(8), day(-205), day(-200)]);
      await db.query(
        `INSERT INTO ${S}.marina_doc_requirement (id, owner_id, type, name, description, schema, mandatory, sort_order)
         VALUES (1, $1, 'insurance', 'Insurance', '', '[{"name":"policy_number","label":"Policy number","type":"string"}]', 1, 0)`, [A]);
      const doc = (id, owner, booking, path, extracted = '{}', expiry = null, requirement = 1) => db.query(
        `INSERT INTO ${S}.marina_document (id, owner_id, requirement_id, booking_id, status, notes, submitted_at, verified_at, type, file_url, file_name, extracted_data, expiry_date)
         VALUES ($1, $2, $3, $4, 'pending', '', now(), NULL, 'insurance', $5, $6, $7, $8)`,
        [id, owner, requirement, booking, STORE + path, path.split('/').pop(), extracted, expiry]);
      await doc(1, A, 1, `marina-docs/${A}/1/1700000000001.PDF`, '{"policy_number":"P-1"}', '2027-03-31T00:00:00Z'); // linked, inside retention -> copied
      await doc(2, A, 2, `marina-docs/${A}/1/1700000000002.jpg`, '');                                            // linked, outside retention
      await doc(3, A, 1, 'sailor-docs/guest/5/passport/scan%20one.png', 'not json', null, 99);                    // linked wallet file, dangling requirement
      await doc(4, A, null, `marina-docs/${A}/1/1700000000004.pdf`);                                              // unlinked -> archive
      await doc(5, SK, 10, `marina-docs/${SK}/1/1700000000005.png`);                                              // skipped owner's booking -> archive
      await doc(6, A, null, 'sailor-docs/guest/6/insurance/wallet.pdf');                                          // unlinked wallet file -> counted only
      await doc(7, A, 1, `marina-docs/${A}/1/broken.pdf`);                                                        // fetch throws
      await doc(8, A, 1, `marina-docs/${A}/1/notpdf.pdf`);                                                        // bytes don't sniff
      await doc(9, A, null, `marina-docs/${A}/1/broken-orphan.pdf`);                                              // archive fetch throws
      await db.query(`INSERT INTO ${S}.marina_image (id, owner_id, url, description, sort_order, created_at) VALUES (1, $1, $2, 'Pontoon D', 0, now())`,
        [A, `${STORE}marina/${A}/1700000000000.webp`]);
      await db.query(
        `INSERT INTO ${S}.marina_message (id, owner_id, sailor_id, enquiry_cookie_hash, sailor_email, sailor_name, direction, body, created_at, read_at)
         VALUES (1, $1, NULL, 'h1', 'ann.sailor@docs-check.example', 'Ann Sailor', 'sailor', 'Is D1 free?', now(), NULL),
                (2, $1, NULL, 'h1', 'ann.sailor@docs-check.example', 'Ann Sailor', 'marina', 'Yes.', now(), NULL),
                (3, $2, NULL, 'h2', 'dee.sailor@docs-check.example', 'Dee Sailor', 'sailor', 'Hello', now(), NULL)`, [A, SK]);
      const PII = [A, SK, 'harbour@docs-check.example', 'skip@docs-check.example', 'ann.sailor@docs-check.example', 'bob.mariner@docs-check.example',
        'cy.skipper@docs-check.example', 'dee.sailor@docs-check.example', 'Ann Sailor', 'Bob Mariner', 'Cy Skipper', 'Dee Sailor'];
      const docsMap = { owners: {
        [A]: { action: 'create', name: 'Docs Check Property', timezone: 'UTC', clerk_org_id: 'org_check_import_docs' },
        [SK]: { action: 'skip', reason: 'check' },
      } };
      // Blob seams swapped on the module object, the same way the importer
      // calls them. fetchBlob records every URL it is asked for.
      const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
      const stubs = () => {
        const s = { blobs: new Map(), publics: [], fetched: [], calls: 0 };
        blobSeam.store = { put: async (p, buf, type) => { s.calls++; s.blobs.set(p, { buf, type }); }, get: async () => null, del: async () => {} };
        blobSeam.putPublic = async (p, buf, type) => { s.calls++; s.publics.push([p, type]); return 'https://public.example/' + p; };
        s.fetchBlob = async (url) => {
          s.calls++; s.fetched.push(url);
          if (url.includes('broken')) throw new Error('fetch failed');
          if (url.endsWith('.webp')) return { buf: WEBP, contentType: 'image/webp' };
          if (url.includes('notpdf')) return { buf: Buffer.from('not a pdf'), contentType: 'application/pdf' };
          return { buf: Buffer.from('%PDF-1.4 check'), contentType: 'application/pdf' };
        };
        return s;
      };
      // Each run reads targets afresh, so a second run finds the created
      // property through Targets.reruns.
      const runDocs = async (files, s) => {
        const source = await readSource(db, S);
        const plan = planMapping(source, docsMap, await readTargets(db, source, docsMap));
        return importSidon(db, source, plan, { mode: 'commit', target: 'local', files, fetchBlob: s.fetchBlob });
      };
      const docRows = async () => (await db.query(
        `SELECT id, blob_pathname, content_type, size_bytes, file_deleted_at IS NOT NULL AS deleted, requirement_id, extracted_data, expiry_date
           FROM marina_document WHERE marina_id = $1 ORDER BY blob_pathname`, [uid('marina', A)])).rows;
      const countsOf = (report) => {
        const c = report.marinas.find((m) => m.alias === alias(A)).counts;
        return [c.documents_copied, c.documents_not_copied, c.documents_sailor_docs, c.documents_fetch_failed];
      };
      const archiveExpected = [`marina-docs-archive/sidon/${alias(A)}/4.pdf`, `marina-docs-archive/sidon/${alias(A)}/9.pdf`, `marina-docs-archive/sidon/${alias(SK)}/5.png`].sort();
      const imageUrl = async () => (await db.query('SELECT url FROM marina_image WHERE id = $1', [uid('image', 1)])).rows[0].url;

      await check('sourcePath, extOf and typeFromExt edges', async () => {
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/marina-docs/org_x/3/1700000000000.pdf'), 'marina-docs/org_x/3/1700000000000.pdf');
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/sailor-docs/guest/5/passport/scan%20one.PNG'), 'sailor-docs/guest/5/passport/scan one.PNG');
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/marina/x/a.webp?download=1'), 'marina/x/a.webp');
        assert.equal(sourcePath('https://abc.public.blob.vercel-storage.com/bad%E0'), null); // malformed escape
        assert.equal(sourcePath(null), null);
        assert.equal(sourcePath('  '), null);
        assert.equal(sourcePath('not a url'), null);
        assert.equal(extOf('sailor-docs/guest/5/passport/scan one.PNG'), 'png');
        assert.equal(extOf('marina-docs/org_x/3/noext'), 'bin');
        assert.equal(extOf('marina-docs/v1.2/noext'), 'bin'); // a dot in a folder is not an extension
        assert.equal(extOf('a/file.'), 'bin');
        assert.equal(extOf(null), 'bin');
        assert.equal(typeFromExt('pdf'), 'application/pdf');
        assert.equal(typeFromExt('jpg'), 'image/jpeg');
        assert.equal(typeFromExt('jpeg'), 'image/jpeg');
        assert.equal(typeFromExt('png'), 'image/png');
        assert.equal(typeFromExt('webp'), 'application/octet-stream');
        assert.equal(typeFromExt('bin'), 'application/octet-stream');
        assert.equal(typeFromExt('toString'), 'application/octet-stream'); // no prototype lookups
      });

      await check('documents: in-retention marina-docs copied; out-of-retention, failed and sailor-docs rows not copied; sailor-docs never fetched', async () => {
        const s = stubs();
        const report = await runDocs(true, s);
        const P = report.properties[0].property_id;
        const path = (b, d, ext) => `marina-docs/${P}/${uid('booking', b)}/sidon-${d}.${ext}`;
        const rows = new Map((await docRows()).map((r) => [r.id, r]));
        assert.deepEqual([...rows.keys()].sort(), [1, 2, 3, 7, 8].map((d) => uid('document', d)).sort());
        assert.deepEqual({ ...rows.get(uid('document', 1)) }, {
          id: uid('document', 1), blob_pathname: path(1, 1, 'pdf'), content_type: 'application/pdf', size_bytes: 14, deleted: false,
          requirement_id: uid('requirement', 1), extracted_data: { policy_number: 'P-1' }, expiry_date: '2027-03-31',
        });
        assert.equal(s.blobs.get(path(1, 1, 'pdf')).type, 'application/pdf');
        for (const [d, b, ext, type] of [[2, 2, 'jpg', 'image/jpeg'], [3, 1, 'png', 'image/png'], [7, 1, 'pdf', 'application/pdf'], [8, 1, 'pdf', 'application/pdf']]) {
          const r = rows.get(uid('document', d));
          assert.deepEqual([r.blob_pathname, r.content_type, r.size_bytes, r.deleted], [path(b, d, ext), type, 0, true], `document ${d}`);
          assert.equal(s.blobs.has(path(b, d, ext)), false, `document ${d} stored`);
        }
        assert.equal(rows.get(uid('document', 3)).requirement_id, null); // Sidon requirement 99 was never imported
        assert.equal(rows.get(uid('document', 3)).extracted_data, null); // 'not json'
        assert.equal(rows.get(uid('document', 2)).extracted_data, null); // ''
        // Review Focus 4: the sidon-ai wallet is never even requested.
        assert.ok(s.fetched.length > 0);
        assert.deepEqual(s.fetched.filter((u) => (sourcePath(u) || '').startsWith('sailor-docs/')), []);
        assert.ok(!s.fetched.some((u) => u.includes('1700000000002')), 'out-of-retention file fetched');
        assert.deepEqual(countsOf(report), [1, 3, 1, 2]);
        assert.equal(report.sailor_docs_unlinked, 1);
      });

      await check('archive paths for unlinked marina-docs, messages export by alias, webp image via putPublic', async () => {
        const s = stubs();
        const report = await runDocs(true, s);
        const P = report.properties[0].property_id;
        assert.deepEqual([...report.archived].sort(), archiveExpected);
        assert.equal(s.blobs.get(`marina-docs-archive/sidon/${alias(A)}/4.pdf`).type, 'application/pdf');
        assert.equal(s.blobs.has(`marina-docs-archive/sidon/${alias(SK)}/5.png`), true);
        assert.equal(s.blobs.has(`marina-docs-archive/sidon/${alias(A)}/9.pdf`), false); // fetch failed: listed and warned, not stored
        assert.ok(report.warnings.some((w) => w.includes(`marina-docs-archive/sidon/${alias(A)}/9.pdf`)));
        const msgs = s.blobs.get(`marina-docs-archive/sidon-messages/${alias(A)}.json`);
        assert.equal(msgs.type, 'application/json');
        assert.deepEqual(JSON.parse(msgs.buf.toString()).map((m) => m.id).sort(), [1, 2]);
        assert.equal(s.blobs.has(`marina-docs-archive/sidon-messages/${alias(SK)}.json`), true); // skipped owners' messages too
        assert.equal(report.messages_exported, 3);
        assert.ok(![...s.blobs.keys()].some((p) => p.includes(A) || p.includes(SK)), 'owner id in a blob path');
        const imgPath = `marina-images/${P}/${uid('marina', A)}.webp`;
        assert.deepEqual(s.publics, [[imgPath, 'image/webp']]);
        assert.equal(await imageUrl(), 'https://public.example/' + imgPath);
      });

      await check('formatReport lists files by alias and path, with no emails, names or owner ids', async () => {
        const out = formatReport(await runDocs(true, stubs()));
        for (const p of archiveExpected) assert.ok(out.includes(p), `missing ${p}`);
        assert.match(out, /messages exported 3/);
        assert.match(out, /sailor-docs unlinked \(not read\) 1/);
        assert.ok(PII.every((x) => !out.includes(x)), 'report leaks fixture personal data or an owner id');
      });

      await check('a second run writes the same private-store pathnames and archive paths', async () => {
        const s1 = stubs();
        const r1 = await runDocs(true, s1);
        const rows1 = await docRows();
        const s2 = stubs();
        const r2 = await runDocs(true, s2);
        const rows2 = await docRows();
        assert.equal(s1.blobs.size, 5); // document 1, archive 4 and 5, two message exports
        assert.equal(r2.properties[0].created, false);
        assert.deepEqual([...s2.blobs.keys()].sort(), [...s1.blobs.keys()].sort());
        assert.deepEqual([...r2.archived].sort(), [...r1.archived].sort());
        assert.deepEqual(rows2.map((r) => [r.id, r.blob_pathname]), rows1.map((r) => [r.id, r.blob_pathname]));
        // Public image URLs are allowed to differ per run (putPublic adds a random suffix).
      });

      await check('files:false makes no fetch, store, putPublic or export call; rows otherwise the same', async () => {
        const s = stubs();
        const report = await runDocs(false, s);
        assert.equal(s.calls, 0);
        const P = report.properties[0].property_id;
        const rows = await docRows();
        assert.equal(rows.length, 5);
        assert.ok(rows.every((r) => r.deleted && r.size_bytes === 0));
        const d1 = rows.find((r) => r.id === uid('document', 1));
        assert.deepEqual([d1.blob_pathname, d1.content_type], [`marina-docs/${P}/${uid('booking', 1)}/sidon-1.pdf`, 'application/pdf']);
        assert.deepEqual([...report.archived].sort(), archiveExpected); // would-be paths
        assert.equal(report.messages_exported, 0);
        assert.deepEqual(countsOf(report), [0, 4, 1, 0]);
        assert.equal(await imageUrl(), `${STORE}marina/${A}/1700000000000.webp`);
      });
    }

    // ---- Final review: the re-run guard sees post-Switch work on IMPORTED rows ----
    // After Switch, staff can send an imported booking's guest link; the guest
    // then uploads and signs, and staff confirm or cancel. A re-run would
    // cascade-delete all of it (and orphan the uploaded files), so a commit
    // run must refuse. The import's marina.created_at is the reference: an
    // imported row keeps Sidon's timestamps, anything later is OTA activity.
    {
      const I = require('./import-sidon-marina');
      const O = 'org_fr_guard';
      const at = new Date('2026-03-01T00:00:00Z');
      const src = {
        profiles: [{ owner_id: O, slug: 'fr-guard', name: 'FR Guard', lat: null, lng: null, description: null, phone: null, email: null,
          website: null, response_window_hours: null, currency: 'eur', updated_at: at }],
        layouts: [], overlays: [],
        berths: [{ id: 9901, owner_id: O, berth_id: 'G1', overlay_id: null, lat: null, lng: null, length_m: 12, min_length_m: null, beam_m: 4,
          depth_m: null, status: 'available', guest_name: null, notes: null, price_per_night: 5, price_mode: 'per_metre', rotation: null }],
        tiers: [],
        bookings: [{ id: 9902, owner_id: O, berth_id: 'G1', sailor_name: 'Guard Sailor', sailor_email: 'guard.sailor@example.com', boat_name: 'Guard',
          boat_loa: 10, boat_beam: 3, arrival_date: '2031-05-01', departure_date: '2031-05-04', notes: null, status: 'confirmed',
          payment_intent_id: null, amount_cents: 10000, expires_at: null, created_at: at, updated_at: at }],
        requirements: [], documents: [], templates: [], signatures: [], pois: [], images: [], messages: [],
      };
      const map = { owners: { [O]: { action: 'create', name: 'FR Guard Co', timezone: 'UTC', clerk_org_id: 'org_check_fr_guard' } } };
      const run = async (mode = 'commit') => I.importSidon(db, src, I.planMapping(src, map, await I.readTargets(db, src, map)), { mode, target: 'local', files: false });
      const B = I.uid('booking', 9902);
      const MID = I.uid('marina', O);
      // The whole check runs in one transaction (now() never moves), so age
      // the import instead of waiting for a later write.
      const importedAnHourAgo = async () => { await run(); await db.query("UPDATE marina SET created_at = created_at - interval '1 hour' WHERE id = $1", [MID]); };
      const refused = async (label) => {
        await assert.rejects(run(), (e) => e instanceof I.ImportRefused && e.message.includes(I.alias(O)), `${label}: commit refused`);
        const dry = await run('dry-run');
        assert.ok(dry.warnings.some((w) => w.includes(I.alias(O))), `${label}: dry run warns`);
      };

      await check('guard: an unchanged re-run still passes', async () => {
        await importedAnHourAgo();
        await run();
      });
      await check('guard: a staff change to an imported booking refuses a commit re-run', async () => {
        await importedAnHourAgo();
        await db.query("UPDATE marina_booking SET status = 'cancelled', updated_at = now() WHERE id = $1", [B]);
        await refused('staff change');
      });
      await check('guard: a payment on an imported booking refuses a commit re-run', async () => {
        await importedAnHourAgo();
        await db.query("UPDATE marina_booking SET payment_status = 'held' WHERE id = $1", [B]);
        await refused('payment');
      });
      await check('guard: a guest upload or signature on an imported booking refuses a commit re-run', async () => {
        await importedAnHourAgo();
        await db.query(
          `INSERT INTO marina_document (property_id, marina_id, booking_id, type, blob_pathname, file_name, content_type, size_bytes)
           SELECT property_id, marina_id, id, 'passport', 'marina-docs/x/y/z.pdf', 'p.pdf', 'application/pdf', 1 FROM marina_booking WHERE id = $1`, [B]);
        await refused('upload');
      });
      await check('guard: a contract agreed on an imported booking refuses a commit re-run', async () => {
        await importedAnHourAgo();
        await db.query(
          `INSERT INTO marina_contract_signature (property_id, booking_id, rendered_body) SELECT property_id, id, 'Agreed' FROM marina_booking WHERE id = $1`, [B]);
        await refused('signature');
      });
    }

    // (later tasks append checks here)
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
