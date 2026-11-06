// OpenTravel (OTA XML over SOAP 1.1 + WS-Security) channel: pushes availability
// and rates as OTA_HotelAvailNotifRQ / OTA_HotelRateAmountNotifRQ. A change is
// ok only if every message that carried it was acknowledged.
const { groupRuns, availNotifRQ, rateNotifRQ, parseNotifRS } = require('./messages');

const REQUIRED = ['endpoint_url', 'username', 'password', 'hotel_code', 'inbound_username', 'inbound_password'];
const MAX_RUNS = 200;
const timeouts = { ms: 15000 };

function urlError(value) {
  let u;
  try { u = new URL(value); } catch { return 'endpoint_url must be a URL'; }
  if (u.protocol === 'https:') return null;
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  return u.protocol === 'http:' && local && process.env.NODE_ENV !== 'production' ? null : 'endpoint_url must be https';
}

function validateConfig(config) {
  const c = config || {};
  const errors = [];
  for (const k of Object.keys(c)) if (!REQUIRED.includes(k)) errors.push(`unknown setting ${k}`);
  for (const k of REQUIRED) if (typeof c[k] !== 'string' || !c[k].trim()) errors.push(`${k} is required`);
  if (typeof c.endpoint_url === 'string' && c.endpoint_url.trim()) {
    const e = urlError(c.endpoint_url);
    if (e) errors.push(e);
  }
  return errors;
}

async function send(config, xml) {
  try {
    const res = await fetch(config.endpoint_url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
      body: xml,
      redirect: 'error', // a 307/308 would resend the WS-Security password to wherever it points
      signal: AbortSignal.timeout(timeouts.ms),
    });
    const rs = parseNotifRS(await res.text());
    // A SOAP fault is a 500 with a body; parseNotifRS has already said why.
    return !res.ok && rs.ok ? { ok: false, error: `HTTP ${res.status}` } : rs;
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}` };
  }
}

async function push(channel, changes) {
  const config = channel.config || {};
  const creds = { hotelCode: config.hotel_code, username: config.username, password: config.password };
  const errors = changes.map(() => []);
  const index = new Map(changes.map((c, i) => [c, i]));
  const runs = groupRuns(changes);
  for (let i = 0; i < runs.length; i += MAX_RUNS) {
    const chunk = runs.slice(i, i + MAX_RUNS);
    const messages = [['availability', availNotifRQ({ ...creds, runs: chunk })]];
    if (chunk.some((r) => r.rate !== null && r.rate !== undefined)) {
      messages.push(['rate', rateNotifRQ({ ...creds, currency: channel.currency, runs: chunk })]);
    }
    const replies = await Promise.all(messages.map(([, xml]) => send(config, xml)));
    replies.forEach((rs, m) => {
      if (rs.ok) return;
      const label = messages[m][0];
      for (const run of chunk) {
        if (label === 'rate' && (run.rate === null || run.rate === undefined)) continue;
        for (const c of run.changes) errors[index.get(c)].push(`${label}: ${rs.error}`);
      }
    });
  }
  return errors.map((e) => (e.length ? { ok: false, error: e.join('; ') } : { ok: true }));
}

module.exports = { label: 'OpenTravel', validateConfig, push, MAX_RUNS, timeouts };
