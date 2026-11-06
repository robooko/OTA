// OpenTravel inbound: a partner POSTs OTA_HotelResNotifRQ (SOAP 1.1, WS-Security
// UsernameToken) to /api/channels/:id/inbound. No session or API key; the
// channel's inbound_username/inbound_password are the credential. Errors live in
// the body at HTTP 200 (OpenTravel); only auth/unknown/unparsable use 4xx.
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { isValidUuid } = require('../middleware/validate');
const { receiveReservation } = require('../lib/channels/reservations');
const { parseResNotifRQ, resNotifRS, soapFault } = require('../lib/channels/opentravel/messages');

const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
const same = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const send = (res, status, xml) => res.status(status).type('text/xml; charset=utf-8').send(xml);

const inboundLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => send(res, 429, soapFault('Client', 'too many requests')),
});

async function handleChannelInbound(req, res) {
  try {
    const channel = isValidUuid(req.params.id)
      ? (await pool.query('SELECT * FROM channel WHERE id = $1', [req.params.id])).rows[0] : null;
    if (!channel || channel.adapter !== 'opentravel') return send(res, 404, soapFault('Client', 'unknown channel'));

    const msg = typeof req.body === 'string' ? parseResNotifRQ(req.body) : { error: 'expected an XML body' };
    if (msg.error) return send(res, 400, soapFault('Client', 'unreadable request'));

    const cfg = channel.config || {};
    // Both compares always run, so a wrong username costs the same as a wrong password.
    const userOk = same(msg.username, cfg.inbound_username);
    const passOk = same(msg.password, cfg.inbound_password);
    if (!userOk || !passOk || !cfg.inbound_username) return send(res, 401, soapFault('Client', 'authentication failed'));

    const results = [];
    for (const { _uid, ...r } of msg.reservations) {
      const out = await receiveReservation(channel, r);
      results.push(out.outcome === 'rejected'
        ? { channel_ref: r.channel_ref, error: out.reason }
        : { channel_ref: r.channel_ref, booking_id: out.booking_id });
    }
    return send(res, 200, resNotifRS({ echoToken: msg.echoToken, results }));
  } catch (err) {
    console.error('channel inbound failed', err);
    return send(res, 500, soapFault('Server', 'internal error'));
  }
}

module.exports = { handleChannelInbound, inboundLimiter };
