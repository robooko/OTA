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
class FakeAnthropic {
  constructor() { this.messages = { create: async () => script.shift() ?? { content: [{ type: 'text', text: 'Anything else?' }] } }; }
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
