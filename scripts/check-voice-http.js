// HTTP-level checks for the phone receptionist (controllers/voice.js): the
// real app on an ephemeral port, signed Twilio webhooks, a scripted stand-in
// for the model. Fixtures live under a throwaway property, deleted at the end.
// Local DB only.
//   node -r dotenv/config scripts/check-voice-http.js
delete process.env.ABLY_API_KEY;
process.env.TWILIO_AUTH_TOKEN = 'check-token';
process.env.OTA_API_BASE_URL = 'https://ota.check';
const assert = require('node:assert/strict');
const Twilio = require('twilio');
if (/neon\.tech|render\.com/.test(process.env.DATABASE_URL || '')) throw new Error('refusing to run against a remote DB');

// Each messages.create() pops the next scripted response.
const script = [];
const sent = []; // every request the receptionist made to the model
class FakeAnthropic {
  constructor() { this.messages = { create: async (req) => { sent.push(structuredClone(req)); return script.shift() ?? { content: [{ type: 'text', text: 'Anything else?' }] }; } }; }
}
require.cache[require.resolve('@anthropic-ai/sdk')] = { exports: FakeAnthropic };

const pool = require('../src/db');
const app = require('../src/app');
const tokens = require('../src/lib/tokens');
const { sendOutboundReply, loadInquiryWithProperty } = require('../src/lib/inquiryReplies');

const NUMBER = '+447700900123';
const CALLER = '+447700900999';
const toolUse = (name, input = {}) => ({ type: 'tool_use', id: `tu_${Math.random().toString(36).slice(2)}`, name, input });

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const P = (await one(`INSERT INTO property (name, timezone, voice_enabled, voice_number) VALUES ('Voice Check Salon', 'Europe/London', true, $1) RETURNING id`, [NUMBER])).id;
  await tokens.credit(P, 20000, 'purchase');
  let failed = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`ok   ${name}`); }
    catch (err) { failed++; console.log(`FAIL ${name}\n     ${err.stack}`); }
  };
  // POSTs like Twilio does; `path` is what a previous <Gather action> gave us.
  const call = async (path, params, { sign = true } = {}) => {
    const body = { CallSid: 'CA_check', From: CALLER, To: NUMBER, ...params };
    const signature = Twilio.getExpectedTwilioSignature('check-token', `https://ota.check${path}`, body);
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sign && { 'X-Twilio-Signature': signature }) },
      body: new URLSearchParams(body),
    });
    return { status: r.status, text: await r.text() };
  };
  const nextAction = (xml) => xml.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&');

  try {
    await check('unsigned webhook is rejected', async () => {
      assert.equal((await call('/api/voice', {}, { sign: false })).status, 403);
    });

    await check('unknown number hangs up', async () => {
      const r = await call('/api/voice', { To: '+447700900000' });
      assert.match(r.text, /not taking calls/);
    });

    let action;
    await check('greeting charges one call and listens', async () => {
      const before = await tokens.getBalance(P);
      const r = await call('/api/voice', {});
      assert.match(r.text, /<Gather input="speech"/);
      assert.match(r.text, /Voice Check Salon/);
      assert.equal(before - (await tokens.getBalance(P)), tokens.TOKEN_COSTS.voice_call);
      action = nextAction(r.text);
    });

    let inquiryId;
    await check('take_enquiry without email files a phone enquiry', async () => {
      script.push(
        { content: [toolUse('take_enquiry', { name: 'Sam', summary: 'Haircut Saturday morning', event_date: '2026-10-24', event_type: 'Haircut' })] },
        { content: [{ type: 'text', text: "Thanks Sam, I've passed that on." }] },
      );
      const r = await call(action, { SpeechResult: 'Can I get a haircut Saturday morning? I am Sam.' });
      assert.match(r.text, /passed that on/);
      const row = await one(`SELECT * FROM event_inquiry WHERE property_id = $1`, [P]);
      assert.equal(row.source, 'phone');
      assert.equal(row.email, null);
      assert.equal(row.phone, CALLER);
      assert.match(row.message, /Caller: Can I get a haircut/);
      inquiryId = row.id;
      action = nextAction(r.text);
      assert.match(action, new RegExp(`e=${inquiryId}`));
    });

    await check('a second take_enquiry updates the same enquiry', async () => {
      script.push(
        { content: [toolUse('take_enquiry', { name: 'Sam Jones', summary: 'Haircut Saturday morning', email: 'sam@example.org' })] },
        { content: [{ type: 'text', text: 'Updated.' }] },
      );
      await call(action, { SpeechResult: 'My email is sam at example dot org' });
      const rows = (await pool.query(`SELECT name, email FROM event_inquiry WHERE property_id = $1`, [P])).rows;
      assert.deepEqual(rows, [{ name: 'Sam Jones', email: 'sam@example.org' }]);
    });

    await check('replying to an enquiry with no email is a 400, nothing charged', async () => {
      await pool.query(`UPDATE event_inquiry SET email = NULL WHERE id = $1`, [inquiryId]);
      const before = await tokens.getBalance(P);
      const inquiry = await loadInquiryWithProperty(inquiryId);
      await assert.rejects(sendOutboundReply({ inquiry, body: 'Hi' }), (err) => err.status === 400);
      assert.equal(await tokens.getBalance(P), before);
    });

    await check('no transfer number: the transfer tool is not offered', async () => {
      // transfer_call isn't in the tool list, so a caller asking for a person gets an enquiry offer.
      script.push({ content: [toolUse('transfer_call')] }, { content: [{ type: 'text', text: 'I can take a message.' }] });
      const r = await call(action, { SpeechResult: 'Can I talk to someone?' });
      assert.doesNotMatch(r.text, /<Dial>/);
    });

    await check('transfer dials the transfer number', async () => {
      await pool.query(`UPDATE property SET voice_transfer_number = '+447700900555' WHERE id = $1`, [P]);
      script.push({ content: [{ type: 'text', text: 'Putting you through.' }, toolUse('transfer_call')] });
      const r = await call(action, { SpeechResult: 'Can I talk to someone?' });
      assert.match(r.text, /<Dial>\+447700900555<\/Dial>/);
    });

    // Number management over the API-key rail, with Twilio stubbed.
    const twilioLib = require('../src/lib/twilio');
    const bought = [];
    const released = [];
    Object.assign(twilioLib, {
      canManageNumbers: () => true,
      searchNumbers: async () => ['+447700900200'],
      buyNumber: async (n, url) => { bought.push([n, url]); return n; },
      releaseNumber: async (n) => { released.push(n); },
    });
    const KEY = `check_${Math.random().toString(36).slice(2)}`;
    const Q = (await one(`INSERT INTO property (name, timezone, api_key, api_key_enabled) VALUES ('Voice Check Two', 'Europe/London', $1, true) RETURNING id`, [KEY])).id;
    const api = async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    try {
      await check('search lists numbers', async () => {
        const r = await api('GET', '/api/property/voice/available-numbers?contains=7700');
        assert.deepEqual(r.json.numbers, ['+447700900200']);
      });
      await check('provision buys, points at the webhook and switches on', async () => {
        const r = await api('POST', '/api/property/voice/number', { phone_number: '+447700900200' });
        assert.equal(r.status, 201);
        assert.deepEqual(bought, [['+447700900200', 'https://ota.check/api/voice']]);
        assert.equal(r.json.number, '+447700900200');
        assert.equal(r.json.enabled, true);
      });
      await check('a second number is refused and nothing is bought', async () => {
        const r = await api('POST', '/api/property/voice/number', { phone_number: '+447700900201' });
        assert.equal(r.status, 409);
        assert.equal(bought.length, 1);
      });
      await check('a non-UK number is refused', async () => {
        assert.equal((await api('POST', '/api/property/voice/number', { phone_number: '+15005550006' })).status, 400);
      });
      await check('set_voice_enabled switches it off', async () => {
        const r = await api('PUT', '/api/property/voice/enabled', { enabled: false });
        assert.equal(r.json.enabled, false);
        assert.equal((await api('PUT', '/api/property/voice/enabled', { enabled: 'yes' })).status, 400);
      });
      await check('release gives the number back and clears it', async () => {
        const r = await api('DELETE', '/api/property/voice/number');
        assert.deepEqual(released, ['+447700900200']);
        assert.equal(r.json.number, null);
        assert.equal((await api('DELETE', '/api/property/voice/number')).status, 404);
      });
      await check('list_event_inquiries filters by source', async () => {
        await pool.query(`INSERT INTO event_inquiry (property_id, name, email, message, source) VALUES ($1, 'Web', 'w@example.org', 'Hi', 'web'), ($1, 'Call', NULL, 'Caller: hi', 'phone')`, [Q]);
        const r = await api('GET', '/api/event-inquiries?source=phone');
        assert.deepEqual(r.json.map((i) => i.name), ['Call']);
      });
    } finally {
      await pool.query(`DELETE FROM event_inquiry WHERE property_id = $1`, [Q]);
      await pool.query(`DELETE FROM property WHERE id = $1`, [Q]);
    }

    // Booking on the call, against a spa open every day 09:00-17:00.
    const spaId = (await one(`INSERT INTO spa (property_id, name) VALUES ($1, 'Check Spa') RETURNING id`, [P])).id;
    await one(`INSERT INTO spa_treatment (property_id, spa_id, name, duration_mins, price) VALUES ($1, $2, 'Haircut', 30, 20) RETURNING id`, [P, spaId]);
    const barber = (await one(`INSERT INTO spa_therapist (property_id, spa_id, name) VALUES ($1, $2, 'Alex') RETURNING id`, [P, spaId])).id;
    for (let d = 1; d <= 7; d++) {
      await pool.query(`INSERT INTO spa_therapist_hours (property_id, therapist_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, '09:00', '17:00')`, [P, barber, d]);
    }
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    try {
      await check('with a spa, it is told to book and offered the tools', async () => {
        sent.length = 0;
        script.push({ content: [toolUse('check_availability', { date_from: tomorrow, date_to: tomorrow, treatment_name: 'haircut' })] }, { content: [{ type: 'text', text: 'Ten or eleven tomorrow?' }] });
        const r = await call(action, { SpeechResult: 'Can I book a haircut tomorrow?' });
        assert.match(r.text, /Ten or eleven/);
        assert.deepEqual(sent[0].tools.map((t) => t.name), ['take_enquiry', 'check_availability', 'book_appointment', 'transfer_call']);
        assert.match(sent[0].system, /book_appointment/);
        const result = JSON.parse(sent[1].messages.at(-1).content[0].content);
        assert.equal(result.treatment, 'Haircut');
        assert.ok(result.slots[0].slots.some((s) => s.time === '10:00'));
      });
      await check('book_appointment holds the time for the caller', async () => {
        sent.length = 0;
        script.push({ content: [toolUse('book_appointment', { treatment_name: 'Haircut', date: tomorrow, time: '10:00', name: 'Sam Jones', email: 'sam@example.org' })] }, { content: [{ type: 'text', text: 'Booked.' }] });
        await call(action, { SpeechResult: 'Ten please, sam at example dot org, yes that is right' });
        const result = JSON.parse(sent[1].messages.at(-1).content[0].content);
        assert.equal(result.booked, true);
        const appt = await one(`SELECT contact_name, contact_email, contact_phone, status, start_time::text FROM spa_appointment WHERE property_id = $1`, [P]);
        assert.deepEqual(appt, { contact_name: 'Sam Jones', contact_email: 'sam@example.org', contact_phone: CALLER, status: 'pending', start_time: '10:00:00' });
        const enquiry = await one(`SELECT name, email, event_type, event_time::text, source, message FROM event_inquiry WHERE property_id = $1 AND event_type = 'Haircut'`, [P]);
        assert.equal(enquiry.source, 'phone');
        assert.equal(enquiry.event_time, '10:00:00');
        assert.match(enquiry.message, /^Booked Haircut on .* at 10:00 by phone\.[\s\S]*Caller: Ten please/);
      });
      await check('a taken time is refused in words', async () => {
        sent.length = 0;
        script.push({ content: [toolUse('book_appointment', { treatment_name: 'Haircut', date: tomorrow, time: '10:00', name: 'Alex Other', email: 'alex@example.org' })] }, { content: [{ type: 'text', text: 'Sorry.' }] });
        await call(action, { SpeechResult: 'Ten please' });
        assert.deepEqual(JSON.parse(sent[1].messages.at(-1).content[0].content), { booked: false, reason: 'That time has just gone.' });
      });
    } finally {
      await pool.query(`DELETE FROM spa_appointment WHERE property_id = $1`, [P]);
      await pool.query(`DELETE FROM spa_therapist_hours WHERE property_id = $1`, [P]);
      await pool.query(`DELETE FROM spa_therapist WHERE property_id = $1`, [P]);
      await pool.query(`DELETE FROM spa_treatment WHERE property_id = $1`, [P]);
      await pool.query(`DELETE FROM spa WHERE property_id = $1`, [P]);
    }

    await check('out of BUXS: greeting goes straight to staff', async () => {
      await pool.query(`UPDATE buxs_wallet SET balance = 0 WHERE owner = $1`, [`property:${P}`]);
      const r = await call('/api/voice', {});
      assert.match(r.text, /<Dial>/);
    });
  } finally {
    script.length = 0;
    await pool.query(`DELETE FROM event_inquiry WHERE property_id = $1`, [P]);
    await pool.query(`DELETE FROM buxs_ledger WHERE owner = $1`, [`property:${P}`]);
    await pool.query(`DELETE FROM buxs_wallet WHERE owner = $1`, [`property:${P}`]);
    await pool.query(`DELETE FROM property WHERE id = $1`, [P]);
    server.close();
    await pool.end();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
