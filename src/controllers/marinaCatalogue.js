const pool = require('../db');
const { isValidUuid, isValidUrl } = require('../middleware/validate');
const { sniffType, putPublic } = require('../lib/marinaDocuments');
const { unknownPlaceholders } = require('../lib/marinaContracts');
const { TYPES, TYPE_NAMES } = require('../lib/sailorDocTypes');
const { applyPlacement, PLACEMENT_COLS, DOCK_SIDES } = require('../lib/pierPlacement');

// Staff CRUD for marinas and their catalogue tables. Every child table is
// property-scoped and soft-deletes through status, so one table-driven
// handler set serves all of them; list returns active rows (berths: all
// but inactive) unless ?include_inactive=1 (the dashboard's Reactivate);
// get returns any status.

const badRequest = (res, error) => res.status(400).json({ error });
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Same shape check as the guest booking form (marinaGuard.js).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// column -> validator returning the stored value or throws {status:400}
const fail = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
const v = {
  text: (max) => (x) => (x == null || x === '' ? null : typeof x === 'string' && x.length <= max ? x : fail(`must be text up to ${max} characters`)),
  required: (max) => (x) => (typeof x === 'string' && x.trim() && x.length <= max ? x.trim() : fail('is required')),
  longText: (x) => (x == null || x === '' ? null : typeof x === 'string' ? x : fail('must be text')),
  num: (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : fail('must be a number')),
  // Prices and sizes: a negative one prices a stay below zero or fits any boat.
  nonNeg: (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : fail('must be a number, 0 or more')),
  int: (x) => (x == null || x === '' ? null : Number.isInteger(Number(x)) ? Number(x) : fail('must be an integer')),
  bool: (x) => (typeof x === 'boolean' ? x : fail('must be true or false')),
  date: (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? x : fail('must be YYYY-MM-DD')),
  dateOrNull: (x) => (x == null || x === '' ? null : v.date(x)),
  oneOf: (...opts) => (x) => (opts.includes(x) ? x : fail(`must be one of ${opts.join(', ')}`)),
  json: (x) => (Array.isArray(x) ? JSON.stringify(x) : fail('must be an array')),
  url: (x) => (x == null || x === '' ? null : isValidUrl(x) ? x : fail('must be an http(s) URL')),
  email: (x) => (x == null || x === '' ? null : typeof x === 'string' && x.length <= 255 && EMAIL_RE.test(x) ? x : fail('must be an email address')),
  uuidOrNull: (x) => (x == null ? null : isValidUuid(x) ? x : fail('must be a UUID')),
};
const STATUS = v.oneOf('active', 'inactive');

const TABLES = {
  pontoons: { table: 'marina_pontoon', order: 'sort_order, name', cols: {
    name: v.required(100), svg_data: v.longText, sw_lat: v.num, sw_lng: v.num, ne_lat: v.num, ne_lng: v.num, rotation: v.num, sort_order: v.int, status: STATUS }, required: ['name'] },
  berths: { table: 'marina_berth', order: 'label', listWhere: "status <> 'inactive'", cols: {
    label: v.required(30), pontoon_id: v.uuidOrNull, lat: v.num, lng: v.num, rotation: v.num,
    dock_side: (x) => (x == null || x === '' ? null : v.oneOf(...DOCK_SIDES)(x)),
    length_m: v.nonNeg, min_length_m: v.nonNeg, beam_m: v.nonNeg, depth_m: v.nonNeg, price_per_night: v.nonNeg,
    price_mode: v.oneOf('per_metre', 'fixed'), notes: v.longText, status: v.oneOf('active', 'maintenance', 'inactive') }, required: ['label'] },
  seasons: { table: 'marina_season', order: 'valid_from, name', cols: {
    name: v.required(100), valid_from: v.date, valid_to: v.date, repeats_yearly: v.bool, status: STATUS }, required: ['name', 'valid_from', 'valid_to'] },
  // A tier has a season (its dates) or its own valid_from/valid_to.
  'price-tiers': { table: 'marina_price_tier', order: 'valid_from, max_length_m', cols: {
    season_id: v.uuidOrNull, valid_from: v.dateOrNull, valid_to: v.dateOrNull, max_length_m: v.nonNeg, max_beam_m: v.nonNeg, price_per_night: v.nonNeg,
    price_per_month: v.nonNeg, price_per_year: v.nonNeg, status: STATUS }, required: ['max_length_m', 'price_per_night'] },
  'doc-requirements': { table: 'marina_doc_requirement', order: 'sort_order, name', cols: {
    type: v.oneOf(...TYPE_NAMES), name: v.required(100), description: v.longText, fields: v.json, mandatory: v.bool, sort_order: v.int, status: STATUS }, required: ['type', 'name'] },
  'contract-templates': { table: 'marina_contract_template', order: 'min_nights, name', cols: {
    name: v.required(100), body_markdown: v.required(200000), min_nights: v.int, status: STATUS }, required: ['name', 'body_markdown'] },
  pois: { table: 'marina_poi', order: 'label', cols: {
    label: v.required(100), type: v.text(30), lat: v.num, lng: v.num, status: STATUS }, required: ['label', 'lat', 'lng'] },
  images: { table: 'marina_image', order: 'sort_order', cols: {
    url: v.url, description: v.longText, sort_order: v.int, status: STATUS }, required: ['url'] },
};

const MARINA_COLS = {
  name: v.required(100), slug: (x) => (typeof x === 'string' && SLUG_RE.test(x) && x.length <= 100 ? x : fail('must be lowercase letters, digits and dashes')),
  description: v.longText, phone: v.text(30), email: v.email, website: v.url, lat: v.num, lng: v.num,
  layout_svg: v.longText, layout_sw_lat: v.num, layout_sw_lng: v.num, layout_ne_lat: v.num, layout_ne_lng: v.num, layout_rotation: v.num,
  response_window_hours: (x) => (Number.isInteger(x) && x >= 1 && x <= 144 ? x : fail('must be a whole number of hours, 1-144')),
  auto_confirm: v.bool,
  sailor_documents: v.bool,
  kind: v.oneOf('marina', 'mooring'),
  map_style: v.oneOf('satellite', 'street', 'nautical'),
  booking_url: (x) => (x == null || x === '' ? null : isValidUrl(x) && x.includes('{id}') && x.includes('{token}') ? x : fail('must be an http(s) URL containing {id} and {token}')),
  status: STATUS,
};

const MARINA_REQUIRED = ['name', 'slug'];

// Picks and validates the provided columns; on create, every `required`
// column must be present.
function pick(body, cols, { create, required = [] }) {
  const out = {};
  for (const [col, check] of Object.entries(cols)) {
    if (body?.[col] === undefined) continue;
    try { out[col] = check(body[col]); } catch (e) { e.message = `${col} ${e.message}`; throw e; }
  }
  if (create) for (const col of required) if (out[col] == null) fail(`${col} is required`);
  return out;
}

// A berth's pontoon must be one of its own marina's -- the FK alone would
// accept any pontoon id, including another property's.
async function checkPontoon(client, marinaId, values) {
  if (!values.pontoon_id) return;
  const { rowCount } = await client.query('SELECT 1 FROM marina_pontoon WHERE id = $1 AND marina_id = $2', [values.pontoon_id, marinaId]);
  if (!rowCount) fail('pontoon_id must be a pontoon of this marina');
}

// valid_to is inclusive, so a one-day tier has valid_from = valid_to.
// Dates are 'YYYY-MM-DD' strings (src/db sets the DATE parser), so string
// order is date order.
function checkTierDates(t) {
  if (t.valid_from > t.valid_to) fail('valid_to must be on or after valid_from');
}

// A repeating season longer than a year would overlap its own next year.
function checkSeason(s) {
  checkTierDates(s);
  if (s.repeats_yearly && `${Number(s.valid_from.slice(0, 4)) + 1}${s.valid_from.slice(4)}` <= s.valid_to) fail('a season that repeats every year must be shorter than a year');
}

// A tier's season must be one of its own marina's; without one it needs its own dates.
async function checkTier(client, marinaId, t) {
  if (t.season_id) {
    const { rowCount } = await client.query('SELECT 1 FROM marina_season WHERE id = $1 AND marina_id = $2', [t.season_id, marinaId]);
    if (!rowCount) fail('season_id must be a season of this marina');
  } else if (!t.valid_from || !t.valid_to) fail('season_id, or valid_from and valid_to, is required');
  else checkTierDates(t);
}

async function marinaOr404(req, res, client = pool) {
  if (!isValidUuid(req.params.marina_id)) { res.status(404).json({ error: 'Marina not found' }); return null; }
  const { rows: [m] } = await client.query('SELECT * FROM marina WHERE id = $1 AND property_id = $2', [req.params.marina_id, req.property_id]);
  if (!m) res.status(404).json({ error: 'Marina not found' });
  return m || null;
}

function insertSql(table, values) {
  const cols = Object.keys(values);
  return { text: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, values: Object.values(values) };
}
function updateSql(table, values, id, propertyId) {
  const cols = Object.keys(values);
  return {
    text: `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1} AND property_id = $${cols.length + 2} RETURNING *`,
    values: [...Object.values(values), id, propertyId],
  };
}

// --- marinas ---------------------------------------------------------------

async function listMarinas(req, res, next) {
  try {
    // ?include_inactive=1 (exactly '1'): every status, for the dashboard's Reactivate.
    const all = req.query.include_inactive === '1';
    const { rows } = await pool.query(`SELECT * FROM marina WHERE property_id = $1${all ? '' : " AND status = 'active'"} ORDER BY name`, [req.property_id]);
    res.json(rows);
  } catch (err) { next(err); }
}

// Unauthenticated, every property: map pins for Sidon. Public fields only.
async function listPublicMarinas(req, res, next) {
  try {
    const { rows } = await pool.query(`SELECT id, name, kind, map_style, description, website, lat, lng,
      (SELECT url FROM marina_image i WHERE i.marina_id = marina.id AND i.status = 'active' ORDER BY sort_order LIMIT 1) AS image_url
      FROM marina WHERE status = 'active' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name`);
    res.set('Cache-Control', 'public, max-age=300').json(rows);
  } catch (err) { next(err); }
}

async function getMarina(req, res, next) {
  try {
    req.params.marina_id = req.params.id;
    const m = await marinaOr404(req, res);
    if (m) res.json(m);
  } catch (err) { next(err); }
}

async function createMarina(req, res, next) {
  try {
    const values = pick(req.body, MARINA_COLS, { create: true, required: MARINA_REQUIRED });
    const { rows: [m] } = await pool.query(insertSql('marina', { ...values, property_id: req.property_id }));
    res.status(201).json(m);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A marina with that slug already exists' });
    next(err);
  }
}

async function updateMarina(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Marina not found' });
    const values = pick(req.body, MARINA_COLS, { create: false });
    if (!Object.keys(values).length) return badRequest(res, 'Nothing to update');
    const { rows: [m] } = await pool.query(updateSql('marina', values, req.params.id, req.property_id));
    if (!m) return res.status(404).json({ error: 'Marina not found' });
    res.json(m);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A marina with that slug already exists' });
    next(err);
  }
}

// --- children --------------------------------------------------------------

// Contract templates: flag placeholders that will render blank (document
// fields like {{acord25.*}} aren't supported in phase 1, typos never are).
function withWarnings(table, row) {
  if (table !== 'marina_contract_template') return row;
  const unknown = unknownPlaceholders(row.body_markdown);
  return unknown.length ? { ...row, warnings: { unknown_placeholders: unknown } } : row;
}

function childHandlers(kind) {
  const { table, order, cols, listWhere = "status = 'active'", required } = TABLES[kind];
  return {
    list: async (req, res, next) => {
      try {
        if (!(await marinaOr404(req, res))) return;
        // ?include_inactive=1 (exactly '1'): every status, same order -- the
        // dashboard's setup tabs show inactive rows with Reactivate.
        const where = req.query.include_inactive === '1' ? '' : ` AND ${listWhere}`;
        const { rows } = await pool.query(`SELECT * FROM ${table} WHERE marina_id = $1${where} ORDER BY ${order}`, [req.params.marina_id]);
        res.json(rows);
      } catch (err) { next(err); }
    },
    create: async (req, res, next) => {
      try {
        if (!(await marinaOr404(req, res))) return;
        const values = pick(req.body, cols, { create: true, required });
        if (table === 'marina_berth') await checkPontoon(pool, req.params.marina_id, values);
        if (table === 'marina_price_tier') await checkTier(pool, req.params.marina_id, values);
        if (table === 'marina_season') checkSeason(values);
        // No fields given: the type's shared extraction list, as sidon-marina's presets did.
        if (table === 'marina_doc_requirement' && (!values.fields || values.fields === '[]')) values.fields = JSON.stringify(TYPES[values.type].fields);
        const { rows: [row] } = await pool.query(insertSql(table, { ...values, property_id: req.property_id, marina_id: req.params.marina_id }));
        if (table === 'marina_pontoon') row.placement = await applyPlacement(pool, row);
        res.status(201).json(withWarnings(table, row));
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'That label is already used at this marina' });
        next(err);
      }
    },
    update: async (req, res, next) => {
      const client = await pool.connect();
      try {
        if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
        const values = pick(req.body, cols, { create: false });
        if (!Object.keys(values).length) return badRequest(res, 'Nothing to update');
        await client.query('BEGIN');
        const { rows: [before] } = await client.query(`SELECT * FROM ${table} WHERE id = $1 AND marina_id = $2 AND property_id = $3 FOR UPDATE`, [req.params.id, req.params.marina_id, req.property_id]);
        if (!before) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
        if (table === 'marina_berth') await checkPontoon(client, req.params.marina_id, values);
        // Against the stored row: an update may move just one end.
        if (table === 'marina_price_tier') await checkTier(client, req.params.marina_id, { ...before, ...values });
        if (table === 'marina_season') checkSeason({ ...before, ...values });
        const { rows: [row] } = await client.query(updateSql(table, values, req.params.id, req.property_id));
        // A berth's label is what its pontoon SVG's data-berth-id points
        // at; keep them in step in the same transaction.
        if (table === 'marina_berth' && values.label && values.label !== before.label && row.pontoon_id) {
          await client.query(
            'UPDATE marina_pontoon SET svg_data = $1 WHERE id = $2',
            [renameBerthInSvg((await client.query('SELECT svg_data FROM marina_pontoon WHERE id = $1 FOR UPDATE', [row.pontoon_id])).rows[0].svg_data, before.label, values.label), row.pontoon_id]
          );
        }
        // Saving a pontoon's drawing, corners or turn re-places its berths.
        if (table === 'marina_pontoon' && PLACEMENT_COLS.some((c) => c in values)) row.placement = await applyPlacement(client, row);
        await client.query('COMMIT');
        res.json(withWarnings(table, row));
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ error: 'That label is already used at this marina' });
        next(err);
      } finally { client.release(); }
    },
  };
}

// Hard delete, only while no upload points at it (the FK would just null
// requirement_id and orphan the upload's history); otherwise Deactivate.
async function deleteDocRequirement(req, res, next) {
  try {
    if (!isValidUuid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const { rows: [r] } = await pool.query(
      `SELECT EXISTS (SELECT 1 FROM marina_document WHERE requirement_id = r.id) AS used FROM marina_doc_requirement r
       WHERE r.id = $1 AND r.marina_id = $2 AND r.property_id = $3`, [req.params.id, req.params.marina_id, req.property_id]);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (r.used) return res.status(409).json({ error: 'Documents have been uploaded against this requirement; deactivate it instead' });
    await pool.query('DELETE FROM marina_doc_requirement WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM marina_document WHERE requirement_id = $1)', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function renameBerthInSvg(svg, oldLabel, newLabel) {
  if (!svg) return svg;
  const re = new RegExp(`data-berth-id=(["'])${escapeRegExp(oldLabel)}\\1`, 'g');
  return svg.replace(re, (_, q) => `data-berth-id=${q}${newLabel}${q}`);
}

// CSV import from the dashboard: rows already parsed client-side. Upserts
// by label so a re-import updates instead of duplicating. All or nothing.
async function bulkBerths(req, res, next) {
  const client = await pool.connect();
  try {
    if (!(await marinaOr404(req, res))) return;
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) return badRequest(res, 'rows must be an array of 1-2000 berths');
    const parsed = rows.map((r, i) => {
      try { return pick(r, TABLES.berths.cols, { create: true, required: TABLES.berths.required }); } catch (e) { e.message = `row ${i + 1}: ${e.message}`; throw e; }
    });
    await client.query('BEGIN');
    const out = [];
    for (const values of parsed) {
      await checkPontoon(client, req.params.marina_id, values);
      const full = { ...values, property_id: req.property_id, marina_id: req.params.marina_id };
      const cols = Object.keys(full);
      const updates = cols.filter((c) => !['property_id', 'marina_id', 'label'].includes(c));
      const { rows: [row] } = await client.query(
        `INSERT INTO marina_berth (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (marina_id, label) DO ${updates.length ? `UPDATE SET ${updates.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}` : 'NOTHING'}
         RETURNING *`,
        Object.values(full)
      );
      if (row) out.push(row);
    }
    await client.query('COMMIT');
    res.json({ upserted: out.length, data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally { client.release(); }
}

// Staff image upload into OTA's PUBLIC blob store (not the documents store).
async function uploadImage(req, res, next) {
  try {
    const m = await marinaOr404(req, res);
    if (!m) return;
    const type = sniffType(req.body);
    if (!['image/jpeg', 'image/png'].includes(type)) return res.status(400).json({ error: 'Only JPEG or PNG images' });
    const url = await putPublic(`marina-images/${req.property_id}/${m.id}.${type === 'image/png' ? 'png' : 'jpg'}`, req.body, type);
    const { rows: [img] } = await pool.query('INSERT INTO marina_image (property_id, marina_id, url, description) VALUES ($1, $2, $3, $4) RETURNING *', [req.property_id, m.id, url, req.get('X-Description')?.slice(0, 500) ?? null]);
    res.status(201).json(img);
  } catch (err) { next(err); }
}

module.exports = {
  uploadImage, listMarinas, listPublicMarinas, getMarina, createMarina, updateMarina, childHandlers, deleteDocRequirement, bulkBerths, renameBerthInSvg, TABLES };
