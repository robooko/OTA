// Moves Sidon Marina's marina data into OTA (spec: Cutover steps 2 and 4).
// Reads Sidon with raw SQL and explicit column lists (8 of its table names
// are OTA's too, and its drizzle schema.ts lists columns live doesn't have),
// plans the mapping from a map file, and writes in one target transaction.
//   node scripts/import-sidon-marina.js --map [<map-file>] [--live]
// <map-file> defaults to .superpowers/import-map.local.json (.live.json with --live).
// Output carries owner aliases, slugs and counts only: never a name, an
// email or a Sidon owner id.
require('dotenv').config();
require('../src/db'); // DATE as 'YYYY-MM-DD' strings, for every pg client in the process
const crypto = require('crypto');
const fs = require('fs');
const { Client } = require('pg');
const { emailKey } = require('../src/lib/spaBookingGuard');
const { propertyToday } = require('../src/lib/marinaQueries');
const { STARTER_BALANCE } = require('../src/lib/tokens'); // the pool behind it is lazy; nothing connects
const { unknownPlaceholders } = require('../src/lib/marinaContracts');
const docs = require('../src/lib/marinaDocuments');

class ImportRefused extends Error {}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const alias = (ownerId) => 'o_' + sha1(String(ownerId)).slice(0, 6);

// UUID v5-style from Sidon identity, so re-runs keep booking ids (and with
// them booking tokens and blob paths) stable.
function uid(table, id) {
  const h = sha1(`sidon:${table}:${id}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Sidon tier dates look like '2026-06-01T00:00:00.000+01:00': the date the
// operator typed. Converting zones would move it a day for zones behind +01:00.
const tierDate = (text) => String(text).slice(0, 10);

function cleanEmail(s) {
  const t = String(s ?? '').trim();
  return t.indexOf('@') >= 1 ? t : null;
}

const STATUSES = new Set(['pending', 'confirmed', 'declined', 'cancelled']);
// A pending request nobody answered before it lapsed (or before the stay
// ended) is dead: OTA would never act on it.
function mapBookingStatus(b, today, now) {
  if (!STATUSES.has(b.status)) return null;
  if (b.status === 'pending' && (b.expires_at == null || b.expires_at <= now || b.departure_date < today)) {
    return { status: 'cancelled', cancel_reason: 'expired' };
  }
  return { status: b.status, cancel_reason: null };
}

const daysBefore = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
// Mirrors marinaDocuments.retentionOnce: a file it would delete on its first
// pass is not worth copying.
function insideRetention(b, today, now) {
  if (b.departure !== null && b.departure < daysBefore(today, 90)) return false;
  if ((b.status === 'cancelled' || b.status === 'declined') && b.updated_at < new Date(now.getTime() - 90 * 864e5)) return false;
  return true;
}

const DECISIONS = new Set(['accept_as_property_currency', 'drop_prices']);
function loadMap(path) {
  let map;
  try { map = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (err) { throw new ImportRefused(`map file ${path}: ${err.message}`); }
  if (!map || typeof map.owners !== 'object' || Array.isArray(map.owners)) throw new ImportRefused('map file: "owners" must be an object');
  for (const [key, e] of Object.entries(map.owners)) {
    const at = `map owner ${key.startsWith('o_') ? key : alias(key)}`;
    if (!e || !['property', 'create', 'skip', 'rekey'].includes(e.action)) throw new ImportRefused(`${at}: unknown action`);
    if (e.currency_decision === 'reprice') throw new ImportRefused(`${at}: currency_decision 'reprice' is not supported in phase 1`);
    if (e.currency_decision != null && !DECISIONS.has(e.currency_decision)) throw new ImportRefused(`${at}: unknown currency_decision`);
    if (e.action === 'property' && typeof e.property_id !== 'string') throw new ImportRefused(`${at}: property_id is required`);
    if (e.action === 'create') {
      // Without an org the owner's first sign-in auto-creates a second, empty
      // property, so "no org" must be said explicitly: clerk_org_id: null
      // means an API-key-only property nobody signs in to.
      if (e.clerk_org_id !== null && !e.clerk_org_id) throw new ImportRefused(`${at}: clerk_org_id is required for create (null for an API-key-only property)`);
      if (!e.name || !e.timezone) throw new ImportRefused(`${at}: name and timezone are required for create`);
    }
    if (e.action === 'skip' && !e.reason) throw new ImportRefused(`${at}: skip needs a reason`);
    if (e.action === 'rekey' && !e.to_owner) throw new ImportRefused(`${at}: rekey needs to_owner`);
  }
  return map;
}

// Exactly the live columns (survey sidon-import.md §1); schema is
// 'sidon_fixture' in the check.
const SOURCE_SQL = {
  profiles: 'SELECT owner_id, slug, name, lat, lng, description, phone, email, website, response_window_hours, currency, updated_at FROM %s.marina_profile ORDER BY owner_id',
  layouts: 'SELECT owner_id, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation FROM %s.marina_layout ORDER BY owner_id',
  overlays: 'SELECT id, owner_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order FROM %s.marina_overlay ORDER BY id',
  berths: 'SELECT id, owner_id, berth_id, overlay_id, lat, lng, length_m, min_length_m, beam_m, depth_m, status, guest_name, notes, price_per_night, price_mode, rotation FROM %s.marina_berth ORDER BY id',
  tiers: 'SELECT id, owner_id, valid_from, valid_to, max_len_m, max_beam_m, price_per_night, price_per_month, price_per_year, created_at FROM %s.marina_price_tier ORDER BY id',
  bookings: 'SELECT id, owner_id, berth_id, sailor_name, sailor_email, boat_name, boat_loa, boat_beam, arrival_date, departure_date, notes, status, payment_intent_id, amount_cents, expires_at, created_at, updated_at FROM %s.berth_booking ORDER BY created_at, id',
  requirements: 'SELECT id, owner_id, type, name, description, schema, mandatory, sort_order FROM %s.marina_doc_requirement ORDER BY id',
  documents: 'SELECT id, owner_id, requirement_id, booking_id, status, notes, submitted_at, verified_at, type, file_url, file_name, extracted_data, expiry_date FROM %s.marina_document ORDER BY id',
  templates: 'SELECT id, owner_id, name, body_markdown, min_nights, active, created_at FROM %s.marina_contract_template ORDER BY id',
  signatures: 'SELECT id, owner_id, template_id, booking_id, rendered_body, signed_at, ip_address, user_agent FROM %s.marina_contract_signature ORDER BY id',
  pois: 'SELECT id, owner_id, label, type, lat, lng FROM %s.marina_poi ORDER BY id',
  images: 'SELECT id, owner_id, url, description, sort_order, created_at FROM %s.marina_image ORDER BY id',
  messages: 'SELECT id, owner_id, sailor_id, enquiry_cookie_hash, sailor_email, sailor_name, direction, body, created_at, read_at FROM %s.marina_message ORDER BY id',
};

// SELECTs only: the caller owns the transaction (the CLI opens it READ ONLY).
async function readSource(src, schema = 'public') {
  if (!/^[a-z_]+$/.test(schema)) throw new ImportRefused(`bad source schema ${schema}`);
  const out = {};
  for (const [k, sql] of Object.entries(SOURCE_SQL)) out[k] = (await src.query(sql.replace('%s', schema))).rows;
  return out;
}

const TABLES = Object.keys(SOURCE_SQL);
const ownersIn = (source) => [...new Set(TABLES.flatMap((t) => source[t].map((r) => r.owner_id)))].sort();

// Map keys may be an owner id or its alias (G2). Returns owner id -> entry,
// plus refusals for keys matching no owner or an ambiguous alias.
function resolveKeys(map, owners) {
  const byOwner = new Map();
  const refusals = [];
  const find = (key) => {
    if (owners.includes(key)) return key;
    const hits = owners.filter((o) => alias(o) === key);
    if (hits.length > 1) { refusals.push(`alias ${key} matches ${hits.length} owners: use the owner id`); return null; }
    if (!hits.length) { refusals.push(`map key ${key.startsWith('o_') ? key : alias(key)} matches no Sidon owner`); return null; }
    return hits[0];
  };
  for (const [key, entry] of Object.entries(map.owners)) {
    const id = find(key);
    if (id) byOwner.set(id, entry);
  }
  return { byOwner, refusals, find };
}

const createKey = (e) => `create:${e.clerk_org_id}:${e.name}`;

// Read-only: the target state the plan depends on.
async function readTargets(dst, source, map) {
  const owners = ownersIn(source);
  const { byOwner } = resolveKeys(map, owners);
  const properties = {};
  const reruns = {};
  const loadProps = async (ids) => {
    const { rows } = await dst.query('SELECT id, currency, timezone, clerk_org_id FROM property WHERE id::text = ANY($1)', [ids]);
    for (const r of rows) properties[r.id] = { currency: r.currency, timezone: r.timezone, clerk_org_id: r.clerk_org_id };
  };
  await loadProps([...byOwner.values()].filter((e) => e.action === 'property').map((e) => e.property_id));
  const groups = new Map();
  for (const [id, e] of byOwner) if (e.action === 'create') groups.set(createKey(e), [...(groups.get(createKey(e)) || []), id]);
  for (const [key, ids] of groups) {
    // A previous run's property: by its marinas first (one per owner), then
    // by the first owner it was created for.
    const { rows: [m] } = await dst.query('SELECT property_id FROM marina WHERE sidon_owner_id = ANY($1) LIMIT 1', [ids]);
    const { rows: [p] } = m ? { rows: [] } : await dst.query('SELECT id FROM property WHERE sidon_marina_id = ANY($1) LIMIT 1', [ids]);
    const pid = m?.property_id ?? p?.id;
    if (pid) reruns[key] = pid;
  }
  await loadProps(Object.values(reruns));
  return { properties, reruns };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Pure: everything the import will do, or why it won't.
function planMapping(source, map, targets) {
  const owners = ownersIn(source);
  const { byOwner, refusals, find } = resolveKeys(map, owners);
  const profile = new Map(source.profiles.map((p) => [p.owner_id, p]));
  const hasRows = (id) => TABLES.some((t) => t !== 'messages' && source[t].some((r) => r.owner_id === id));
  const plan = { properties: [], owners: [], currencyFlags: [], suggestions: [], refusals };
  const propByKey = new Map();

  // Importing owners first, in map-file order (owners[0] becomes sidon_marina_id).
  for (const [id, e] of byOwner) {
    if (e.action !== 'property' && e.action !== 'create') continue;
    const a = alias(id);
    const p = profile.get(id);
    if (!p) { refusals.push(`${a} has no marina profile: rekey or skip it`); continue; }
    let pp;
    if (e.action === 'property') {
      const t = targets.properties[e.property_id];
      if (!t) { refusals.push(`${a}: property ${e.property_id} not found on the target`); continue; }
      pp = propByKey.get(e.property_id);
      if (!pp) {
        pp = { key: e.property_id, property_id: e.property_id, create: null, currency: t.currency.toUpperCase(), owners: [] };
        propByKey.set(pp.key, pp);
        plan.properties.push(pp);
      }
    } else {
      const key = createKey(e);
      const currency = String(e.currency ?? p.currency).toUpperCase();
      pp = propByKey.get(key);
      if (!pp) {
        const rerun = targets.reruns[key];
        pp = rerun
          ? { key, property_id: rerun, create: null, currency: targets.properties[rerun].currency.toUpperCase(), owners: [], timezone: e.timezone, wanted: currency }
          : { key, property_id: null, create: { name: e.name, timezone: e.timezone, clerk_org_id: e.clerk_org_id, currency }, currency, owners: [], timezone: e.timezone, wanted: currency };
        propByKey.set(key, pp);
        plan.properties.push(pp);
      } else if (pp.timezone !== e.timezone || pp.wanted !== currency) {
        // G1: owners sharing one created property must agree on both.
        refusals.push(`${a}: timezone/currency differ from the other owners of "${e.name}"`);
        continue;
      }
    }
    pp.owners.push(id);
    const slug = e.slug ?? p.slug ?? slugify(p.name);
    if (!SLUG.test(slug)) refusals.push(`${a}: slug "${slug}" is not a valid slug`);
    const marinaCurrency = String(p.currency).toUpperCase();
    const decision = e.currency_decision ?? null;
    if (marinaCurrency !== pp.currency) {
      plan.currencyFlags.push({ alias: a, marina_currency: marinaCurrency, property_currency: pp.currency, decision });
      // A guest would pay the right number in the wrong currency.
      if (!decision) refusals.push(`${a}: marina currency ${marinaCurrency} differs from property currency ${pp.currency}; set currency_decision`);
    }
    plan.owners.push({ owner_id: id, alias: a, action: 'import', property_key: pp.key, slug,
      prices: decision === 'drop_prices' ? 'drop' : 'keep', rekey_to: null, reason: null });
  }
  for (const pp of plan.properties) { delete pp.timezone; delete pp.wanted; }

  const importing = new Set(plan.owners.map((o) => o.owner_id));
  const slugs = new Map();
  for (const o of plan.owners) {
    if (slugs.has(o.slug)) refusals.push(`${o.alias} and ${slugs.get(o.slug)} both use slug "${o.slug}"`);
    slugs.set(o.slug, o.alias);
  }

  for (const id of owners) {
    if (importing.has(id)) continue;
    const a = alias(id);
    const e = byOwner.get(id);
    if (e?.action === 'property' || e?.action === 'create') continue; // refused above
    if (e?.action === 'skip') { plan.owners.push({ owner_id: id, alias: a, action: 'skip', property_key: null, slug: null, prices: 'keep', rekey_to: null, reason: e.reason }); continue; }
    if (e?.action === 'rekey') {
      const to = find(e.to_owner);
      if (to && !importing.has(to)) refusals.push(`${a}: rekey target ${alias(to)} is not an importing owner`);
      if (to) plan.owners.push({ owner_id: id, alias: a, action: 'rekey', property_key: null, slug: null, prices: 'keep', rekey_to: to, reason: null });
      continue;
    }
    // G13: absent owners are auto-skipped only when nothing but messages hangs off them.
    if (!hasRows(id)) plan.owners.push({ owner_id: id, alias: a, action: 'skip', property_key: null, slug: null, prices: 'keep', rekey_to: null, reason: 'no child rows' });
    else refusals.push(`${a} is not in the map and has rows: add property/create/rekey/skip`);
  }

  // Re-key hints for profile-less owners: the overlays their berths sit on,
  // and labels that exist in exactly one profiled marina.
  const labelsOf = new Map();
  for (const b of source.berths) if (profile.has(b.owner_id)) labelsOf.set(b.berth_id, [...new Set([...(labelsOf.get(b.berth_id) || []), b.owner_id])]);
  const overlayOwner = new Map(source.overlays.map((o) => [o.id, o.owner_id]));
  for (const id of owners) {
    if (profile.has(id) || !hasRows(id)) continue;
    const cands = new Set();
    for (const b of source.berths) if (b.owner_id === id && overlayOwner.has(b.overlay_id) && profile.has(overlayOwner.get(b.overlay_id))) cands.add(overlayOwner.get(b.overlay_id));
    for (const r of [...source.berths, ...source.bookings]) {
      const hit = r.owner_id === id && labelsOf.get(r.berth_id);
      if (hit && hit.length === 1) cands.add(hit[0]);
    }
    plan.suggestions.push({ alias: alias(id), rekey_to_alias: cands.size === 1 ? alias([...cands][0]) : null });
  }
  return plan;
}

// For terminals and sign-off: aliases, slugs and map-file property names only.
function formatPlan(plan) {
  const name = (key) => {
    const pp = plan.properties.find((p) => p.key === key);
    return pp.create ? `create "${pp.create.name}" (${pp.create.currency}, ${pp.create.timezone})` : `${pp.property_id} (${pp.currency})`;
  };
  const out = ['properties:'];
  for (const pp of plan.properties) out.push(`  ${name(pp.key)} <- ${pp.owners.map(alias).join(', ')}`);
  out.push('owners:');
  for (const o of plan.owners) {
    if (o.action === 'import') out.push(`  ${o.alias} import as ${o.slug}${o.prices === 'drop' ? ' (prices dropped)' : ''}`);
    else if (o.action === 'rekey') out.push(`  ${o.alias} rekey -> ${alias(o.rekey_to)}`);
    else out.push(`  ${o.alias} skip: ${o.reason}`);
  }
  if (plan.currencyFlags.length) out.push('currency flags:', ...plan.currencyFlags.map((f) => `  ${f.alias}: marina ${f.marina_currency}, property ${f.property_currency}, decision ${f.decision ?? 'none'}`));
  if (plan.suggestions.length) out.push('profile-less owners:', ...plan.suggestions.map((s) => `  ${s.alias}: ${s.rekey_to_alias ? `suggest rekey -> ${s.rekey_to_alias}` : 'no single match (skip, or rekey by hand)'}`));
  if (plan.refusals.length) out.push('refusals:', ...plan.refusals.map((r) => `  ${r}`));
  return out.join('\n');
}

// ── Writing: one target transaction, owned by the caller ──

const nz = (v) => (v === '' ? null : v); // two Sidon profiles store '' for "not set"
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100); // Sidon's float4 noise -> NUMERIC(…,2)
const BERTH_STATUS = { available: 'active', occupied: 'active', reserved: 'active', maintenance: 'maintenance' };
const zeroCounts = () => ({
  pontoons: 0, berths: 0, berths_duplicate: 0, pontoon_nulled: 0,
  tiers: 0, requirements: 0, templates: 0, pois: 0, images: 0,
  bookings: 0, bookings_no_berth: 0, bookings_overlap: 0, pending_expired: 0, emails_nulled: 0,
  occupancy: 0, occupancy_overlap: 0, signatures: 0,
  documents_copied: 0, documents_not_copied: 0, documents_sailor_docs: 0, documents_fetch_failed: 0,
});

// ---- importSidon steps 6-8: bookings, occupancy, signatures (R13, R15, R16) ----

// One row under its own savepoint: an exclusion violation (23P01, an
// overlapping live stay on the berth) skips just that row instead of
// aborting the whole run's transaction. Any other error still aborts.
async function insertOrOverlap(dst, sql, params) {
  await dst.query('SAVEPOINT b');
  try {
    await dst.query(sql, params);
    await dst.query('RELEASE SAVEPOINT b');
    return true;
  } catch (err) {
    if (err.code !== '23P01') throw err;
    await dst.query('ROLLBACK TO SAVEPOINT b');
    return false;
  }
}

// Returns Map<Sidon booking id, ImportedBooking> for signatures (here) and
// documents (step 9). Everything is looked up through the deterministic ids
// step 4 wrote, so this needs no in-memory maps from the catalogue steps.
async function importBookings(dst, source, plan, report, opts) {
  const now = opts.now ?? new Date();
  const owners = new Map(plan.owners.map((o) => [o.owner_id, o]));
  // Re-keyed owners' rows are counted under their target (R13).
  const counts = (ownerId) => report.marinas.find((m) => m.alias === alias(ownerId)).counts;
  const targets = new Map();
  const target = async (ownerId) => {
    if (!targets.has(ownerId)) {
      const marinaId = uid('marina', ownerId);
      const { rows: [m] } = await dst.query(
        'SELECT m.property_id, upper(p.currency) AS currency FROM marina m JOIN property p ON p.id = m.property_id WHERE m.id = $1',
        [marinaId]);
      const { rows } = await dst.query('SELECT id, label FROM marina_berth WHERE marina_id = $1', [marinaId]);
      targets.set(ownerId, {
        marina_id: marinaId, property_id: m.property_id, currency: m.currency,
        // "Today" is the target property's own calendar day (Pacific/Tahiti
        // can be a day behind UTC), never the server's.
        today: await propertyToday(dst, m.property_id),
        drop: owners.get(ownerId).prices === 'drop',
        berths: new Map(rows.map((r) => [r.label, r.id])),
      });
    }
    return targets.get(ownerId);
  };

  // Step 6: Source.bookings is already in created_at, id order, so the
  // later of an overlapping pair is the one skipped.
  const imported = new Map();
  for (const b of source.bookings) {
    const o = owners.get(b.owner_id);
    if (!o || o.action === 'skip') continue;
    const targetOwner = o.action === 'rekey' ? o.rekey_to : o.owner_id;
    const t = await target(targetOwner);
    const c = counts(targetOwner);
    const berthId = t.berths.get(b.berth_id);
    if (!berthId) { c.bookings_no_berth += 1; continue; }
    const mapped = mapBookingStatus(b, t.today, now);
    if (!mapped) { report.warnings.push(`${alias(b.owner_id)}: a booking with an unknown status was skipped`); continue; }
    const email = cleanEmail(b.sailor_email);
    const id = uid('booking', b.id);
    const ok = await insertOrOverlap(dst,
      `INSERT INTO marina_booking (id, property_id, marina_id, berth_id, contact_name, contact_email, contact_email_key,
         boat_name, boat_length_m, boat_beam_m, arrival, departure, status, cancel_reason, source, locale,
         total_price, currency, payment_status, legacy_payment_intent_id, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, round($9::numeric, 2), round($10::numeric, 2), $11, $12, $13, $14,
         'import', 'en', $15, $16, 'none', $17, $18, $19, $20)`,
      [id, t.property_id, t.marina_id, berthId, b.sailor_name, email, emailKey(email),
        b.boat_name, b.boat_loa, b.boat_beam, b.arrival_date, b.departure_date, mapped.status, mapped.cancel_reason,
        // drop_prices: the Sidon number is in the marina's currency, not the property's (Review Focus 1).
        b.amount_cents == null || t.drop ? null : b.amount_cents / 100, t.currency,
        b.payment_intent_id, b.notes, b.created_at, b.updated_at]);
    if (!ok) { c.bookings_overlap += 1; continue; }
    c.bookings += 1;
    if (b.status === 'pending' && mapped.cancel_reason === 'expired') c.pending_expired += 1;
    if (email === null) c.emails_nulled += 1;
    imported.set(b.id, { id, owner_id: targetOwner, property_id: t.property_id, marina_id: t.marina_id,
      status: mapped.status, cancel_reason: mapped.cancel_reason, departure: b.departure_date,
      updated_at: b.updated_at, today: t.today, email });
  }

  // Step 7: Sidon kept manual occupancy on the berth; OTA only has bookings,
  // so each still-occupied berth becomes an open-ended stay from today (R16).
  for (const s of source.berths) {
    if (s.status !== 'occupied' && s.status !== 'reserved') continue;
    const o = owners.get(s.owner_id);
    if (!o || o.action !== 'import') continue;
    const t = await target(s.owner_id);
    const berthId = uid('berth', s.id);
    const { rows: [r] } = await dst.query(
      `SELECT EXISTS (SELECT 1 FROM marina_berth WHERE id = $1) AS imported,
              EXISTS (SELECT 1 FROM marina_booking WHERE berth_id = $1 AND status IN ('hold', 'pending', 'confirmed')
                        AND daterange(arrival, departure) @> $2::date) AS covered`,
      [berthId, t.today]);
    if (!r.imported || r.covered) continue;
    const ok = await insertOrOverlap(dst,
      `INSERT INTO marina_booking (id, property_id, marina_id, berth_id, contact_name, arrival, departure, status,
         source, locale, total_price, currency, payment_status)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, 'confirmed', 'import', 'en', NULL, $7, 'none')`,
      [uid('occupancy', s.id), t.property_id, t.marina_id, berthId,
        (s.guest_name || '').trim().slice(0, 100) || 'Reserved', t.today, t.currency]);
    counts(s.owner_id)[ok ? 'occupancy' : 'occupancy_overlap'] += 1;
  }

  // Step 8: only for bookings imported above ("skipped with their booking").
  // The template is NULL when it wasn't imported (e.g. a re-keyed owner's,
  // when the target already had one).
  for (const s of source.signatures) {
    const b = imported.get(s.booking_id);
    if (!b) continue;
    // Sidon has no one-signature-per-booking rule; OTA does (UNIQUE booking_id).
    const { rowCount } = await dst.query(
      `INSERT INTO marina_contract_signature (id, property_id, booking_id, template_id, rendered_body, signer_email,
         agreed_at, ip_address, user_agent)
       VALUES ($1, $2, $3, (SELECT id FROM marina_contract_template WHERE id = $4), $5, $6, $7, $8, $9)
       ON CONFLICT (booking_id) DO NOTHING`,
      [uid('signature', s.id), b.property_id, b.id, uid('template', s.template_id), s.rendered_body, b.email,
        s.signed_at, s.ip_address, s.user_agent]);
    counts(b.owner_id).signatures += rowCount;
  }
  return imported;
}
async function importCore(dst, source, plan, opts) {
  if (plan.refusals.length) throw new ImportRefused(plan.refusals.join('; '));
  const report = {
    mode: opts.mode, target: opts.target, files: opts.files,
    properties: [], marinas: [], rekeys: [], skips: [], currencyFlags: plan.currencyFlags,
    unknownPlaceholders: [], archived: [], sailor_docs_unlinked: 0, messages_exported: 0, warnings: [],
  };
  const importing = plan.owners.filter((o) => o.action === 'import');
  const ownerIds = importing.map((o) => o.owner_id);
  const byOwner = (rows, ownerId) => rows.filter((r) => r.owner_id === ownerId);

  // 1. Re-run guard (R11, G5). The delete below cascades through every
  // booking on these marinas, so once OTA holds real work on them (Switch has
  // happened) a commit must stop rather than erase it. That is a guest or
  // staff booking, an enquiry, or OTA activity on an IMPORTED booking: staff
  // can send its guest link, the guest then uploads and signs, and staff
  // confirm or cancel. Imported rows keep Sidon's timestamps and the import's
  // own rows share its transaction time (marina.created_at), so anything later
  // is OTA's; so are documents and signatures with ids this import never made
  // (a cascade would also orphan an uploaded file for good). A dry run reports
  // the same thing and carries on, since nothing it writes is kept.
  const { rows: hits } = await dst.query(
    `SELECT m.id, m.sidon_owner_id,
            (SELECT count(*) FROM marina_booking b WHERE b.marina_id = m.id AND b.source <> 'import')::int AS bookings,
            (SELECT count(*) FROM event_inquiry e WHERE e.marina_id = m.id)::int AS enquiries,
            (SELECT count(*) FROM marina_booking b WHERE b.marina_id = m.id AND b.source = 'import'
               AND (b.updated_at > m.created_at OR b.payment_status <> 'none'))::int
          + (SELECT count(*) FROM marina_document d WHERE d.marina_id = m.id
               AND (d.id <> ALL($2::uuid[]) OR d.submitted_at > m.created_at OR d.verified_at > m.created_at))::int
          + (SELECT count(*) FROM marina_contract_signature s JOIN marina_booking b ON b.id = s.booking_id
               WHERE b.marina_id = m.id AND s.id <> ALL($3::uuid[]))::int AS touched
     FROM marina m WHERE m.sidon_owner_id = ANY($1)`,
    [ownerIds, source.documents.map((d) => uid('document', d.id)), source.signatures.map((x) => uid('signature', x.id))]);
  const switched = hits.filter((h) => h.bookings || h.enquiries || h.touched);
  if (switched.length) {
    const lines = switched.map((h) =>
      `${alias(h.sidon_owner_id)} has ${h.bookings} non-import booking(s), ${h.enquiries} enquiry(ies) and ${h.touched} imported row(s) changed in OTA: Switch has happened and a re-import would delete them`);
    if (opts.mode === 'commit') throw new ImportRefused(lines.join('; '));
    report.warnings.push(...lines.map((l) => `${l} (dry run continues; nothing is kept)`));
    // event_inquiry.marina_id has no ON DELETE, so the delete would fail on
    // it; unlinking inside this rolled-back transaction lets the rehearsal finish.
    await dst.query('UPDATE event_inquiry SET marina_id = NULL WHERE marina_id = ANY($1)', [switched.map((h) => h.id)]);
  }

  // 2. Properties. A reused one is never written (G3): its currency,
  // timezone and interim sidon_marina_id stay exactly as staff set them.
  const propertyIdOf = new Map();
  const todayOf = new Map();
  for (const p of plan.properties) {
    let id = p.property_id;
    if (p.create) {
      id = (await dst.query(
        `INSERT INTO property (name, clerk_org_id, currency, timezone, api_key, api_key_enabled, sidon_marina_id)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
        [p.create.name, p.create.clerk_org_id, p.create.currency.toUpperCase(), p.create.timezone,
          'prop_' + crypto.randomBytes(32).toString('hex'), p.owners[0]])).rows[0].id;
      // grantStarter() opens its own pool connection, which is bound to
      // DATABASE_URL even under --live and sits outside this transaction, so
      // the same two writes are made here instead.
      if (STARTER_BALANCE > 0) {
        const { rows: [{ token_balance }] } = await dst.query(
          'UPDATE property SET token_balance = token_balance + $2 WHERE id = $1 RETURNING token_balance', [id, STARTER_BALANCE]);
        await dst.query(
          `INSERT INTO property_token_ledger (property_id, delta, balance_after, reason) VALUES ($1, $2, $3, 'starter')`,
          [id, STARTER_BALANCE, token_balance]);
      }
    }
    propertyIdOf.set(p.key, id);
    todayOf.set(id, await propertyToday(dst, id));
    report.properties.push({ key: p.key, property_id: id, created: !!p.create, today: todayOf.get(id) });
  }

  // 3. Everything under the mapped marinas goes; every child FK cascades.
  await dst.query('DELETE FROM marina WHERE sidon_owner_id = ANY($1)', [ownerIds]);

  // 4. Each importing owner's marina and catalogue, under ids derived from
  // Sidon's (R10), so a re-run lands on the same rows.
  const marinas = new Map();
  const rekeyTo = new Map(plan.owners.filter((o) => o.action === 'rekey').map((o) => [o.owner_id, o.rekey_to]));
  const marinaOf = (ownerId) => marinas.get(rekeyTo.get(ownerId) ?? ownerId);
  const overlayIds = new Set(source.overlays.map((ov) => ov.id));
  const berthIds = new Map();
  const requirementIds = new Map();
  const templateIds = new Map();

  const insertBerth = async (m, b) => {
    // One label per marina: a re-keyed owner's copy of a target berth is a duplicate, not a second berth (R13).
    if (m.labels.has(b.berth_id)) { m.counts.berths_duplicate++; return; }
    let pontoonId = null;
    if (b.overlay_id != null) {
      pontoonId = m.pontoons.get(b.overlay_id) ?? null;
      // An id with no overlay at all is plain NULL. One that exists but belongs to another owner is counted,
      // because it means that owner's map drew this berth.
      if (!pontoonId && overlayIds.has(b.overlay_id)) m.counts.pontoon_nulled++;
    }
    const status = BERTH_STATUS[b.status];
    if (!status) report.warnings.push(`${m.alias}: berth ${b.id} has unknown status '${b.status}', imported as inactive`);
    const id = uid('berth', b.id);
    await dst.query(
      `INSERT INTO marina_berth (id, property_id, marina_id, pontoon_id, label, lat, lng, rotation, length_m, min_length_m, beam_m, depth_m,
         price_per_night, price_mode, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [id, m.property_id, m.id, pontoonId, b.berth_id, b.lat, b.lng, b.rotation,
        round2(b.length_m), round2(b.min_length_m), round2(b.beam_m), round2(b.depth_m),
        m.prices === 'drop' ? null : round2(b.price_per_night), nz(b.price_mode) ?? 'per_metre', nz(b.notes), status ?? 'inactive']);
    m.labels.set(b.berth_id, id);
    berthIds.set(b.id, { id, marina: m });
    m.counts.berths++;
  };

  const insertRequirement = async (m, r) => {
    let fields;
    try { fields = JSON.parse(r.schema); } catch { throw new ImportRefused(`${m.alias}: requirement ${r.id} has a schema that is not JSON`); }
    const id = uid('requirement', r.id);
    await dst.query(
      `INSERT INTO marina_doc_requirement (id, property_id, marina_id, type, name, description, fields, mandatory, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      // pg would send a JS array as a Postgres array, so JSONB gets text.
      [id, m.property_id, m.id, r.type, r.name, nz(r.description), JSON.stringify(fields ?? []), r.mandatory === 1, r.sort_order ?? 0]);
    requirementIds.set(r.id, id);
    m.reqTypes.add(r.type);
    m.counts.requirements++;
  };

  const insertTemplate = async (m, t) => {
    const id = uid('template', t.id);
    await dst.query(
      `INSERT INTO marina_contract_template (id, property_id, marina_id, name, body_markdown, min_nights, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, m.property_id, m.id, t.name, t.body_markdown, t.min_nights ?? 0, t.active === 1 ? 'active' : 'inactive', t.created_at]);
    templateIds.set(t.id, id);
    m.counts.templates++;
    const fields = unknownPlaceholders(t.body_markdown);
    if (fields.length) report.unknownPlaceholders.push({ alias: alias(t.owner_id), template_id: id, fields });
  };

  for (const o of importing) {
    const prof = source.profiles.find((p) => p.owner_id === o.owner_id);
    if (!prof) throw new ImportRefused(`${o.alias} has no marina_profile to import (map it to rekey or skip)`);
    const lay = source.layouts.find((l) => l.owner_id === o.owner_id);
    const pid = propertyIdOf.get(o.property_key);
    const m = {
      id: uid('marina', o.owner_id), property_id: pid, owner_id: o.owner_id, alias: o.alias, prices: o.prices,
      counts: zeroCounts(), pontoons: new Map(), labels: new Map(), reqTypes: new Set(),
    };
    await dst.query(
      `INSERT INTO marina (id, property_id, name, slug, description, phone, email, website, lat, lng,
         layout_svg, layout_sw_lat, layout_sw_lng, layout_ne_lat, layout_ne_lng, layout_rotation,
         response_window_hours, sidon_owner_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'active')`,
      [m.id, pid, prof.name, o.slug, nz(prof.description), nz(prof.phone), nz(prof.email), nz(prof.website), prof.lat, prof.lng,
        nz(lay?.svg_data) ?? null, lay?.sw_lat ?? null, lay?.sw_lng ?? null, lay?.ne_lat ?? null, lay?.ne_lng ?? null, lay?.rotation ?? null,
        prof.response_window_hours ?? 24, o.owner_id]);
    marinas.set(o.owner_id, m);
    report.marinas.push({ alias: o.alias, slug: o.slug, property_id: pid, counts: m.counts });

    for (const ov of byOwner(source.overlays, o.owner_id)) {
      const id = uid('pontoon', ov.id);
      await dst.query(
        `INSERT INTO marina_pontoon (id, property_id, marina_id, name, svg_data, sw_lat, sw_lng, ne_lat, ne_lng, rotation, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, pid, m.id, nz(ov.name) ?? 'Dock', ov.svg_data, ov.sw_lat, ov.sw_lng, ov.ne_lat, ov.ne_lng, ov.rotation, ov.sort_order ?? 0]);
      m.pontoons.set(ov.id, id); // by overlay id, never by name: names repeat across owners
      m.counts.pontoons++;
    }
    for (const b of byOwner(source.berths, o.owner_id)) await insertBerth(m, b);
    // drop_prices: the numbers are in the marina's currency, not the property's, so none are kept (Review Focus 1).
    if (m.prices === 'keep') {
      for (const t of byOwner(source.tiers, o.owner_id)) {
        await dst.query(
          `INSERT INTO marina_price_tier (id, property_id, marina_id, valid_from, valid_to, max_length_m, max_beam_m,
             price_per_night, price_per_month, price_per_year, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          // Tier prices are whole units already (Sidon multiplies by 100 at checkout).
          [uid('tier', t.id), pid, m.id, tierDate(t.valid_from), tierDate(t.valid_to), round2(t.max_len_m), round2(t.max_beam_m),
            t.price_per_night, t.price_per_month, t.price_per_year, t.created_at]);
        m.counts.tiers++;
      }
    }
    for (const r of byOwner(source.requirements, o.owner_id)) await insertRequirement(m, r);
    for (const t of byOwner(source.templates, o.owner_id)) await insertTemplate(m, t);
    for (const p of byOwner(source.pois, o.owner_id)) {
      await dst.query(
        `INSERT INTO marina_poi (id, property_id, marina_id, label, type, lat, lng) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uid('poi', p.id), pid, m.id, p.label, nz(p.type), p.lat, p.lng]);
      m.counts.pois++;
    }
    for (const img of byOwner(source.images, o.owner_id)) {
      await dst.query(
        `INSERT INTO marina_image (id, property_id, marina_id, url, description, sort_order, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uid('image', img.id), pid, m.id, img.url /* Sidon's own public URL, what --no-files keeps */, nz(img.description), img.sort_order ?? 0, img.created_at]);
      m.counts.images++;
    }
  }

  // 5. Re-keyed owners land in their target's marina (R13). Catalogue rows
  // only fill gaps, so the target's own requirements and templates win.
  for (const o of plan.owners.filter((x) => x.action === 'rekey')) {
    const m = marinas.get(o.rekey_to);
    report.rekeys.push({ alias: o.alias, to_alias: m.alias });
    for (const b of byOwner(source.berths, o.owner_id)) await insertBerth(m, b);
    const targetTypes = new Set(m.reqTypes);
    for (const r of byOwner(source.requirements, o.owner_id)) if (!targetTypes.has(r.type)) await insertRequirement(m, r);
    if (m.counts.templates === 0) for (const t of byOwner(source.templates, o.owner_id)) await insertTemplate(m, t);
    const dropped = ['overlays', 'tiers', 'pois', 'images'].reduce((n, k) => n + byOwner(source[k], o.owner_id).length, 0);
    if (dropped) report.warnings.push(`${o.alias} (re-keyed to ${m.alias}): ${dropped} overlay/tier/POI/image row(s) not imported`);
  }
  report.skips = plan.owners.filter((o) => o.action === 'skip').map((o) => ({ alias: o.alias, reason: o.reason }));

  // Steps 6-8; step 9 (documents) classifies each Sidon document by `imported`.
  const imported = await importBookings(dst, source, plan, report, opts);

  return report;
}

// For terminals and sign-off notes: aliases, slugs, property ids and counts
// only. It never carries a name, email or Sidon owner id.
function formatCoreReport(report) {
  const r = report;
  const out = [`import ${r.mode === 'commit' ? 'committed' : 'dry run (rolled back)'}; target ${r.target}; files ${r.files ? 'on' : 'off'}`];
  out.push('properties:', ...r.properties.map((p) => `  ${p.property_id} ${p.created ? 'created' : 'reused'} (today ${p.today})`));
  out.push('marinas:');
  for (const m of r.marinas) {
    out.push(`  ${m.alias} ${m.slug} -> ${m.property_id}`);
    out.push('    ' + Object.entries(m.counts).map(([k, v]) => `${k}=${v}`).join(' '));
  }
  if (r.rekeys.length) out.push('re-keyed:', ...r.rekeys.map((k) => `  ${k.alias} -> ${k.to_alias}`));
  if (r.skips.length) out.push('skipped:', ...r.skips.map((s) => `  ${s.alias}: ${s.reason}`));
  if (r.currencyFlags.length) {
    out.push('currency flags:', ...r.currencyFlags.map((f) =>
      `  ${f.alias}: marina ${f.marina_currency}, property ${f.property_currency}, decision ${f.decision ?? 'none'}`));
  }
  if (r.unknownPlaceholders.length) {
    out.push('template placeholders that render blank:', ...r.unknownPlaceholders.map((u) => `  ${u.alias} template ${u.template_id}: ${u.fields.join(', ')}`));
  }
  if (r.warnings.length) out.push('warnings:', ...r.warnings.map((w) => `  ${w}`));
  return out.join('\n');
}

// ---- Steps 9-10: documents, images, the archive and messages ----

const TYPE_BY_EXT = new Map([['pdf', 'application/pdf'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png']]);

// Sidon file_url values are full public-store URLs. The path inside the
// store (marina-docs/, sailor-docs/, marina/) decides what the import does.
function sourcePath(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl.trim()) return null;
  try { return decodeURIComponent(new URL(fileUrl).pathname.slice(1)) || null; } catch { return null; }
}

// The extension lands in a blob pathname, so anything unusual becomes 'bin'.
function extOf(path) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(String(path ?? '').split('/').pop());
  return m ? m[1].toLowerCase() : 'bin';
}

// For rows whose bytes are never read (G4): the type the file name claims.
// A Map, so 'toString' and friends can't hit Object.prototype.
function typeFromExt(ext) {
  return TYPE_BY_EXT.get(ext) || 'application/octet-stream';
}

// Sidon keeps extracted_data as JSON text; blank or broken text -> NULL.
// Re-stringified so pg sends arrays as JSON, not as a Postgres array.
function extractedJson(text) {
  try { return text && String(text).trim() ? JSON.stringify(JSON.parse(text)) : null; } catch { return null; }
}

// Every Sidon URL is on a public store, so no token is needed.
async function defaultFetchBlob(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
}

async function importSidon(dst, source, plan, opts) {
  const report = await importCore(dst, source, plan, opts); // steps 1-8
  await importFiles(dst, source, plan, opts, report);       // steps 9-10
  return report;
}

// "Linked" means its booking was imported by step 6 of THIS run. That is
// read back from the transaction, so overlap/no-berth skips and skipped
// owners' bookings are simply absent. Every blob call sits behind
// opts.files, so --no-files writes the same rows and touches no store.
async function importFiles(dst, source, plan, opts, report) {
  const { files } = opts;
  const fetchBlob = opts.fetchBlob || defaultFetchBlob;
  const now = opts.now || new Date();
  const importing = plan.owners.filter((o) => o.action === 'import');
  const ownerIds = importing.map((o) => o.owner_id);
  const today = new Map(report.properties.map((p) => [p.property_id, p.today]));
  const counts = new Map();
  for (const o of importing) {
    const c = report.marinas.find((m) => m.alias === o.alias).counts;
    Object.assign(c, { documents_copied: 0, documents_not_copied: 0, documents_sailor_docs: 0, documents_fetch_failed: 0 });
    counts.set(uid('marina', o.owner_id), c); // re-keyed bookings already sit under their target marina
  }
  Object.assign(report, { archived: [], sailor_docs_unlinked: 0, messages_exported: 0 });

  const { rows: booked } = await dst.query(
    `SELECT mb.id, mb.property_id, mb.marina_id, mb.status, mb.departure, mb.updated_at
       FROM marina_booking mb JOIN marina m ON m.id = mb.marina_id
      WHERE mb.id = ANY($1) AND m.sidon_owner_id = ANY($2)`,
    [source.bookings.map((b) => uid('booking', b.id)), ownerIds]);
  const bookings = new Map(booked.map((b) => [b.id, b]));
  const { rows: reqRows } = await dst.query(
    `SELECT r.id FROM marina_doc_requirement r JOIN marina m ON m.id = r.marina_id
      WHERE r.id = ANY($1) AND m.sidon_owner_id = ANY($2)`,
    [source.requirements.map((r) => uid('requirement', r.id)), ownerIds]);
  const reqs = new Set(reqRows.map((r) => r.id));

  for (const d of source.documents) {
    const p = sourcePath(d.file_url);
    const ext = extOf(p);
    const b = d.booking_id == null ? undefined : bookings.get(uid('booking', d.booking_id));
    if (!b) {
      // Unlinked. Sidon's own guest uploads go to the private archive
      // (retentionOnce purges it after 90 days). sailor-docs/* is sidon-ai's
      // wallet: counted, never read.
      if (!p?.startsWith('marina-docs/')) { report.sailor_docs_unlinked += 1; continue; }
      const path = `marina-docs-archive/sidon/${alias(d.owner_id)}/${d.id}.${ext}`;
      report.archived.push(path);
      if (files) {
        const got = await fetchBlob(d.file_url).catch(() => null);
        if (got) await docs.store.put(path, got.buf, got.contentType || typeFromExt(ext));
        else report.warnings.push(`archive copy failed: ${path}`);
      }
      continue;
    }
    const c = counts.get(b.marina_id);
    const pathname = `marina-docs/${b.property_id}/${b.id}/sidon-${d.id}.${ext}`;
    let copied = null;
    if (!p?.startsWith('marina-docs/')) c.documents_sailor_docs += 1; // G4: never fetched
    else if (!files || !insideRetention(b, today.get(b.property_id), now)) c.documents_not_copied += 1;
    else {
      const got = await fetchBlob(d.file_url).catch(() => null);
      const type = got && docs.sniffType(got.buf);
      if (type) {
        await docs.store.put(pathname, got.buf, type);
        copied = { type, size: got.buf.length };
        c.documents_copied += 1;
      } else {
        c.documents_fetch_failed += 1;
        c.documents_not_copied += 1;
      }
    }
    const req = uid('requirement', d.requirement_id);
    // Not-copied rows keep the would-be pathname (NOT NULL) with the file
    // marked deleted, so staff see the document and that its file is gone.
    await dst.query(
      `INSERT INTO marina_document (id, property_id, marina_id, booking_id, requirement_id, type, blob_pathname, file_name,
         content_type, size_bytes, extracted_data, expiry_date, status, notes, submitted_at, verified_at, file_deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $17::boolean THEN NULL ELSE now() END)`,
      [uid('document', d.id), b.property_id, b.marina_id, b.id, reqs.has(req) ? req : null, d.type, pathname, d.file_name,
        copied ? copied.type : typeFromExt(ext), copied ? copied.size : 0, extractedJson(d.extracted_data),
        d.expiry_date ? new Date(d.expiry_date).toISOString().slice(0, 10) : null, // stored at midnight UTC: the UTC date
        d.status, d.notes, d.submitted_at, d.verified_at, copied !== null]);
  }

  if (!files) return;

  // Images were inserted with the Sidon URL (step 4) and are re-hosted here,
  // so every blob call of the run sits behind opts.files. putPublic adds a
  // random suffix: each run gets new URLs and leaves the last run's copies
  // behind (accepted).
  const images = new Map(source.images.map((i) => [uid('image', i.id), i]));
  const { rows: imported } = await dst.query(
    `SELECT i.id, i.property_id, i.marina_id FROM marina_image i JOIN marina m ON m.id = i.marina_id
      WHERE i.id = ANY($1) AND m.sidon_owner_id = ANY($2)`, [[...images.keys()], ownerIds]);
  for (const row of imported) {
    const src = images.get(row.id);
    const got = await fetchBlob(src.url).catch(() => null);
    // Without a copy the row keeps the Sidon URL, which stays public.
    if (!got) { report.warnings.push(`image copy failed: ${alias(src.owner_id)} image ${src.id}`); continue; }
    const ext = extOf(sourcePath(src.url));
    const url = await docs.putPublic(`marina-images/${row.property_id}/${row.marina_id}.${ext}`, got.buf, got.contentType || typeFromExt(ext));
    await dst.query('UPDATE marina_image SET url = $1 WHERE id = $2', [url, row.id]);
  }

  // R17: messages are personal data with no OTA table. One private JSON per
  // owner, any action (skipped owners included), named by alias so the
  // path never shows an owner id. Under marina-docs-archive/ so
  // retentionOnce purges it after 90 days with the document archive.
  for (const [owner, rows] of Map.groupBy(source.messages, (m) => m.owner_id)) {
    await docs.store.put(`marina-docs-archive/sidon-messages/${alias(owner)}.json`, Buffer.from(JSON.stringify(rows)), 'application/json');
    report.messages_exported += rows.length;
  }
}

// The files part of the report: counts, the archive's paths (alias + Sidon
// document id) and totals. No URLs, since Sidon URLs contain owner ids.
function formatFiles(report) {
  const lines = ['', `files${report.files ? '' : ' (--no-files: nothing fetched or stored; archive paths are would-be paths)'}`];
  for (const m of report.marinas) {
    const c = m.counts;
    lines.push(`  ${m.alias} ${m.slug}: documents copied ${c.documents_copied}, not copied ${c.documents_not_copied} (fetch failed ${c.documents_fetch_failed}), sailor-docs ${c.documents_sailor_docs}`);
  }
  lines.push(`  archived ${report.archived.length}:`, ...report.archived.map((p) => `    ${p}`));
  lines.push(`  sailor-docs unlinked (not read) ${report.sailor_docs_unlinked}`, `  messages exported ${report.messages_exported}`);
  return lines;
}

function formatReport(report) {
  return [formatCoreReport(report), ...formatFiles(report)].join('\n');
}

module.exports = { ImportRefused, alias, uid, slugify, tierDate, cleanEmail, mapBookingStatus, insideRetention,
  loadMap, readSource, readTargets, planMapping, importSidon, formatPlan, formatReport, sourcePath, extOf, typeFromExt };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const mapOnly = argv.includes('--map');
  const mode = argv.includes('--dry-run') ? 'dry-run' : 'commit';
  const files = !argv.includes('--no-files');
  const mapFile = argv.find((a) => !a.startsWith('--')) ?? `.superpowers/import-map.${live ? 'live' : 'local'}.json`;
  const ssl = (url) => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });

  const main = async () => {
    const dstKey = live ? 'DATABASE_URL_LIVE' : 'DATABASE_URL';
    const srcUrl = process.env.SIDON_DATABASE_URL;
    const dstUrl = process.env[dstKey];
    if (!srcUrl) throw new ImportRefused('SIDON_DATABASE_URL is not set');
    if (!dstUrl) throw new ImportRefused(`${dstKey} is not set`);
    // 8 Sidon table names are OTA's too: one database for both would read OTA as Sidon.
    if (srcUrl === dstUrl) throw new ImportRefused(`SIDON_DATABASE_URL and ${dstKey} are the same database`);
    if (!mapOnly && files && !(process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_PUBLIC_READ_WRITE_TOKEN)) {
      throw new ImportRefused('BLOB_READ_WRITE_TOKEN and BLOB_PUBLIC_READ_WRITE_TOKEN must both be set (or pass --no-files)');
    }
    const map = loadMap(mapFile);
    const src = new Client({ connectionString: srcUrl, ssl: ssl(srcUrl) });
    const dst = new Client({ connectionString: dstUrl, ssl: ssl(dstUrl) });
    await src.connect();
    await dst.connect();
    try {
      if (!mapOnly) await dst.query('BEGIN');
      try {
        // READ ONLY makes Postgres itself refuse any write to Sidon.
        await src.query('BEGIN READ ONLY');
        const source = await readSource(src);
        await src.query('COMMIT');
        const plan = planMapping(source, map, await readTargets(dst, source, map));
        if (mapOnly) {
          console.log(formatPlan(plan));
          if (plan.refusals.length) process.exitCode = 1;
          return;
        }
        const report = await importSidon(dst, source, plan, { mode, target: live ? 'live' : 'local', files });
        await dst.query(mode === 'commit' ? 'COMMIT' : 'ROLLBACK');
        console.log(formatReport(report));
      } catch (err) {
        if (!mapOnly) await dst.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } finally {
      await src.end();
      await dst.end();
    }
  };

  main().catch((err) => {
    if (!(err instanceof ImportRefused)) throw err; // a real bug: let Node print the stack and exit 1
    console.error(`refused: ${err.message}`);
    process.exitCode = 1;
  });
}
