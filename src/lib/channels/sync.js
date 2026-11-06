// Keeps channels consistent with OTA: diff the desired grid against what each
// channel last acknowledged (channel_ari) and push the difference. The same
// diff is the drift report. Nothing listens for individual changes -- a 60 s
// job plus a debounced nudge after availability refreshes re-diff everything,
// so no change path can be missed and failures heal on the next run.
const pool = require('../../db');
const { ADAPTERS } = require('.');
const { desiredAri, propertyToday } = require('./desired');
const { toCents } = require('../folio');

const BATCH = 500;

async function drift(db, channel, { from, to } = {}) {
  if (channel.status === 'paused') return { changes: [], failed: 0, oldest_failing_date: null };
  const today = await propertyToday(db, channel.property_id);
  const [desired, { rows: sent }] = await Promise.all([
    desiredAri(db, channel, today),
    db.query(
      `SELECT a.mapping_id, m.room_code, m.rate_code, a.date, a.available, a.rate, a.stop_sell, a.status, a.error
       FROM channel_ari a JOIN channel_mapping m ON m.id = a.mapping_id
       WHERE m.channel_id = $1 AND a.date >= $2::date`, [channel.id, today]),
  ]);
  const inRange = (date) => (!from || date >= from) && (!to || date <= to);
  const keyOf = (r) => `${r.mapping_id}|${r.date}`;
  const sentOf = new Map(sent.map((s) => [keyOf(s), s]));
  const previous = (s) => (s ? { available: s.available, rate: Number(s.rate), stop_sell: s.stop_sell, status: s.status, error: s.error } : null);
  const taken = (s, row) => s && s.status === 'ok' && s.available === row.available && s.stop_sell === row.stop_sell && toCents(s.rate) === toCents(row.rate);
  const changes = [];
  for (const row of desired) {
    const s = sentOf.get(keyOf(row));
    sentOf.delete(keyOf(row));
    if (inRange(row.date) && !taken(s, row)) changes.push({ ...row, previous: previous(s) });
  }
  // What's left was sent but is outside the grid now (horizon shortened):
  // close it out, or the channel keeps selling on those old counts.
  for (const s of sentOf.values()) {
    const row = { mapping_id: s.mapping_id, room_code: s.room_code, rate_code: s.rate_code, date: s.date, available: 0, rate: Number(s.rate), stop_sell: true };
    if (inRange(s.date) && !taken(s, row)) changes.push({ ...row, previous: previous(s) });
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

// The dedicated client only holds the advisory lock, inside a transaction it
// keeps open for the run; the work goes through the pool, since
// drift/desiredAri run queries in parallel. Transaction-scoped, not session:
// production goes through Neon's PgBouncer in transaction mode, where an
// unlock can land on a different backend than its lock, leaking the lock for
// that backend's life. An open transaction pins one backend, and COMMIT (or
// the connection dying) always ends the lock.
// The key was 'channel_sync:' until 6 Nov 2026; locks leaked under it on
// production backends block nothing under the new key.
const LOCK_KEY = 'channel_sync_v2:';

async function syncChannel(channelId) {
  const client = await pool.connect();
  // pg-pool drops its idle error listener on checkout, and this client sits
  // idle in a transaction for the whole run: if its backend dies meanwhile
  // (a timeout, a terminate, a Neon restart), an unhandled 'error' would
  // crash the process. Removed in finally, as the client goes back to the pool.
  const onError = (e) => console.error('channel sync lock client:', e.message);
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const locked = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtext($1 || $2)) AS ok`, [LOCK_KEY, channelId])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    const channel = (await pool.query('SELECT * FROM channel WHERE id = $1', [channelId])).rows[0];
    if (!channel) return { skipped: 'missing' };
    channel.currency = (await pool.query('SELECT currency FROM property WHERE id = $1', [channel.property_id])).rows[0]?.currency;
    if (channel.status === 'paused') return { skipped: 'paused' };
    const adapter = ADAPTERS[channel.adapter];
    if (!adapter) throw new Error(`unknown channel adapter ${channel.adapter}`);

    // Re-diff after pushing: anything that changed while we were sending (a
    // booking whose nudge found this lock held) goes out in this same run.
    // Rows already sent this run with the same values (i.e. that just failed)
    // aren't retried here -- the next run does that.
    const sentNow = new Map();
    const sig = (c) => `${c.available}|${toCents(c.rate)}|${c.stop_sell}`;
    let pushed = 0;
    let ok = 0;
    for (let round = 0; round < 3; round++) {
      const todo = (await drift(pool, channel)).changes.filter((c) => sentNow.get(`${c.mapping_id}|${c.date}`) !== sig(c));
      if (!todo.length) break;
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        let results;
        try {
          results = await adapter.push(channel, batch);
        } catch (err) {
          results = batch.map(() => ({ ok: false, error: err.message }));
        }
        await record(pool, batch, results);
        ok += batch.filter((_, j) => results[j]?.ok).length;
      }
      for (const c of todo) sentNow.set(`${c.mapping_id}|${c.date}`, sig(c));
      pushed += todo.length;
    }

    // Drop rows the channel no longer needs: past dates, and dates past the
    // horizon once their close-out was taken.
    const today = await propertyToday(pool, channel.property_id);
    await pool.query(
      `DELETE FROM channel_ari a USING channel_mapping m
       WHERE m.id = a.mapping_id AND m.channel_id = $1
         AND (a.date < $2::date OR (a.date >= $2::date + $3::int AND a.status = 'ok' AND a.available = 0 AND a.stop_sell))`,
      [channel.id, today, channel.horizon_days]);
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

    return { pushed, ok, failed: pushed - ok };
  } finally {
    // Nothing was written on this client, so COMMIT and ROLLBACK both just
    // end the transaction and its lock. If neither gets through, the
    // connection is suspect: destroy it rather than pool it mid-transaction.
    let err;
    await client.query('COMMIT').catch(() => client.query('ROLLBACK')).catch((e) => { err = e; });
    if (err) console.error(`channel sync ${channelId}: could not end the lock transaction, dropping the connection:`, err.message);
    client.off('error', onError);
    client.release(err);
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
