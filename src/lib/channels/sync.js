// Keeps channels consistent with OTA: diff the desired grid against what each
// channel last acknowledged (channel_ari) and push the difference. The same
// diff is the drift report. Nothing listens for individual changes -- a 60 s
// job plus a debounced nudge after availability refreshes re-diff everything,
// so no change path can be missed and failures heal on the next run.
const pool = require('../../db');
const { ADAPTERS } = require('.');
const { desiredAri } = require('./desired');
const { toCents } = require('../folio');

const BATCH = 500;

async function drift(db, channel, { from, to } = {}) {
  if (channel.status === 'paused') return { changes: [], failed: 0, oldest_failing_date: null };
  const [desired, { rows: sent }] = await Promise.all([
    desiredAri(db, channel),
    db.query(
      `SELECT a.mapping_id, a.date, a.available, a.rate, a.stop_sell, a.status, a.error
       FROM channel_ari a JOIN channel_mapping m ON m.id = a.mapping_id
       WHERE m.channel_id = $1 AND a.date >= CURRENT_DATE`, [channel.id]),
  ]);
  const inRange = (date) => (!from || date >= from) && (!to || date <= to);
  const sentOf = new Map(sent.map((s) => [`${s.mapping_id}|${s.date}`, s]));
  const changes = [];
  for (const row of desired) {
    if (!inRange(row.date)) continue;
    const s = sentOf.get(`${row.mapping_id}|${row.date}`);
    if (s && s.status === 'ok' && s.available === row.available && s.stop_sell === row.stop_sell && toCents(s.rate) === toCents(row.rate)) continue;
    changes.push({
      ...row,
      previous: s ? { available: s.available, rate: Number(s.rate), stop_sell: s.stop_sell, status: s.status, error: s.error } : null,
    });
  }
  const failedDates = sent.filter((s) => s.status === 'failed' && inRange(s.date)).map((s) => s.date).sort();
  return { changes, failed: failedDates.length, oldest_failing_date: failedDates[0] ?? null };
}

// Record what was sent: an acknowledged change stores its values; a failed one
// keeps the values the channel last took (or the attempted ones if it never
// took any) and flags the row, so drift shows it and the next run retries.
async function record(db, batch, results) {
  const cols = { mapping: [], date: [], available: [], rate: [], stop: [], status: [], error: [] };
  batch.forEach((c, i) => {
    cols.mapping.push(c.mapping_id); cols.date.push(c.date); cols.available.push(c.available);
    cols.rate.push(c.rate); cols.stop.push(c.stop_sell);
    cols.status.push(results[i]?.ok ? 'ok' : 'failed');
    cols.error.push(results[i]?.ok ? null : (results[i]?.error || 'no result from adapter'));
  });
  await db.query(
    `INSERT INTO channel_ari (mapping_id, date, available, rate, stop_sell, status, error, sent_at)
     SELECT *, now() FROM unnest($1::uuid[], $2::date[], $3::int[], $4::numeric[], $5::bool[], $6::text[], $7::text[])
     ON CONFLICT (mapping_id, date) DO UPDATE SET
       available = CASE WHEN EXCLUDED.status = 'ok' THEN EXCLUDED.available ELSE channel_ari.available END,
       rate      = CASE WHEN EXCLUDED.status = 'ok' THEN EXCLUDED.rate      ELSE channel_ari.rate      END,
       stop_sell = CASE WHEN EXCLUDED.status = 'ok' THEN EXCLUDED.stop_sell ELSE channel_ari.stop_sell END,
       status = EXCLUDED.status, error = EXCLUDED.error, sent_at = now()`,
    [cols.mapping, cols.date, cols.available, cols.rate, cols.stop, cols.status, cols.error]
  );
}

// The dedicated client only holds the advisory lock (session-level); the
// work goes through the pool, since drift/desiredAri run queries in parallel.
async function syncChannel(channelId) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query(`SELECT pg_try_advisory_lock(hashtext('channel_sync:' || $1)) AS ok`, [channelId])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    const channel = (await pool.query('SELECT * FROM channel WHERE id = $1', [channelId])).rows[0];
    if (!channel) return { skipped: 'missing' };
    if (channel.status === 'paused') return { skipped: 'paused' };
    const adapter = ADAPTERS[channel.adapter];
    if (!adapter) throw new Error(`unknown channel adapter ${channel.adapter}`);

    const { changes } = await drift(pool, channel);
    let ok = 0;
    for (let i = 0; i < changes.length; i += BATCH) {
      const batch = changes.slice(i, i + BATCH);
      let results;
      try {
        results = await adapter.push(channel, batch);
      } catch (err) {
        results = batch.map(() => ({ ok: false, error: err.message }));
      }
      await record(pool, batch, results);
      ok += batch.filter((_, j) => results[j]?.ok).length;
    }

    await pool.query(
      `DELETE FROM channel_ari a USING channel_mapping m
       WHERE m.id = a.mapping_id AND m.channel_id = $1 AND a.date < CURRENT_DATE`, [channel.id]);
    // Close-outs that the channel has taken: a pausing channel becomes paused,
    // a closing mapping goes away (its snapshot rows cascade).
    const left = (await drift(pool, channel)).changes;
    if (channel.status === 'pausing' && !left.length) {
      await pool.query(`UPDATE channel SET status = 'paused' WHERE id = $1 AND status = 'pausing'`, [channel.id]);
    }
    const stillOpen = [...new Set(left.map((c) => c.mapping_id))];
    await pool.query(
      `DELETE FROM channel_mapping WHERE channel_id = $1 AND status = 'closing' AND NOT (id = ANY($2::uuid[]))`,
      [channel.id, stillOpen]);

    return { pushed: changes.length, ok, failed: changes.length - ok };
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('channel_sync:' || $1))`, [channelId]).catch(() => {});
    client.release();
  }
}

async function syncAll() {
  const { rows } = await pool.query(`SELECT id FROM channel WHERE status IN ('active', 'pausing') ORDER BY created_at`);
  for (const { id } of rows) {
    try {
      await syncChannel(id);
    } catch (err) {
      console.error(`Channel sync ${id} failed:`, err.message);
    }
  }
}

// Debounced nudge after availability changes, so a booking reaches channels
// in seconds rather than at the next tick. An optimisation only.
let timer = null;
let running = Promise.resolve();
function requestSync() {
  if (timer) return;
  timer = setTimeout(_flush, 2000);
  timer.unref();
}
function _flush() {
  if (!timer) return running;
  clearTimeout(timer);
  timer = null;
  running = running.then(syncAll, syncAll);
  return running;
}

function startChannelSyncJob() {
  const t = setInterval(() => syncAll().catch((err) => console.error('Channel sync failed:', err.message)), 60 * 1000);
  t.unref();
}

module.exports = { drift, syncChannel, syncAll, requestSync, startChannelSyncJob, _flush };
