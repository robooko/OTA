// The AI receptionist by text: Twilio's messaging webhook on the same
// property number as the phone receptionist (controllers/voice.js), with the
// same venue facts, tools and enquiry queue. Point the number's "A message
// comes in" at POST /api/sms; the texted number (`To`) picks the property.
//
// A text has no action URL to carry the conversation, so it lives in
// sms_thread, tool notes and all, for a day after the last message.
const pool = require('../db');
const twilio = require('../lib/twilio');
const tokens = require('../lib/tokens');
const { PUBLIC_BASE_URL, findProperty, runReceptionist, saveEnquiry, MAX_TURNS } = require('./voice');

const THREAD_IDLE_MS = 24 * 60 * 60 * 1000;

const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function reply(res, text) {
  res.type('text/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Message>${esc(text)}</Message>` : ''}</Response>`
  );
}

// ponytail: two texts landing at once each read the same thread and the
// later write wins; fine for a person texting, a per-thread lock if not.
async function saveThread(property, phone, turns, inquiryId) {
  await pool.query(
    `INSERT INTO sms_thread (property_id, phone, turns, inquiry_id, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (property_id, phone) DO UPDATE SET turns = $3, inquiry_id = $4, updated_at = now()`,
    [property.id, phone, JSON.stringify(turns), inquiryId]
  );
}

async function handleSmsWebhook(req, res, next) {
  try {
    const params = req.body ?? {};
    const url = `${PUBLIC_BASE_URL}${req.originalUrl}`;
    if (!twilio.validateWebhook(req.get('x-twilio-signature'), url, params)) return res.status(403).send('Forbidden');

    const property = await findProperty(params.To);
    const phone = /^\+\d{7,15}$/.test(params.From ?? '') ? params.From : null;
    const text = typeof params.Body === 'string' ? params.Body.trim().slice(0, 1000) : '';
    if (!property || !phone || !text) return reply(res, '');

    const { rows: [thread] } = await pool.query(
      'SELECT turns, inquiry_id, updated_at FROM sms_thread WHERE property_id = $1 AND phone = $2',
      [property.id, phone]
    );
    const fresh = !thread || Date.now() - new Date(thread.updated_at).getTime() > THREAD_IDLE_MS;
    const turns = fresh ? [] : thread.turns;
    let inquiryId = fresh ? null : thread.inquiry_id;
    turns.push({ r: 'u', t: text });

    // The team still sees every text it can't answer: out of BUXS, past the
    // turn cap or on a model failure, the message goes to the enquiry queue.
    const toTeam = async (message) => {
      if (!inquiryId) inquiryId = await saveEnquiry(property, phone, { name: 'Text', summary: 'Text message for the team.' }, inquiryId, turns, 'sms');
      turns.push({ r: 'a', t: message });
      await saveThread(property, phone, turns, inquiryId);
      reply(res, message);
    };

    // One charge per conversation, at its first text.
    if (fresh) {
      const spent = await tokens.spend(property.id, 'sms_conversation', params.MessageSid ?? null);
      if (!spent.ok) return toTeam(`Thanks for your message. The team at ${property.name} will get back to you.`);
    }
    if (turns.length > MAX_TURNS * 2) return toTeam('Thanks, the team will pick this up and get back to you.');

    let result;
    try {
      result = await runReceptionist(property, { caller: phone, turns, inquiryId, channel: 'sms' });
    } catch (err) {
      console.error('[sms] agent error:', err.message);
      return toTeam(`Thanks for your message. The team at ${property.name} will get back to you shortly.`);
    }
    inquiryId = result.inquiryId;
    turns.push({ r: 'a', t: [result.reply, ...result.done].join(' ') });
    await saveThread(property, phone, turns, inquiryId);
    reply(res, result.reply || 'Sorry, could you say that again?');
  } catch (err) {
    next(err);
  }
}

module.exports = { handleSmsWebhook };
