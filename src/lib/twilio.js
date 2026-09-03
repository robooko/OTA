const Twilio = require('twilio');

// API-key auth (TWILIO_APIKEY_SID/SECRET), not the account's master auth
// token -- same reasoning as Resend using a scoped key. accountSid is still
// required alongside an API key (it's not a secret, just the account this
// key belongs to). All four unset (or any one missing) -> unconfigured,
// same "off until configured" pattern as ANTHROPIC_API_KEY/RESEND_API_KEY.
let client = null;
if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_APIKEY_SID &&
  process.env.TWILIO_APIKEY_SECRET &&
  process.env.TWILIO_FROM_NUMBER
) {
  client = Twilio(process.env.TWILIO_APIKEY_SID, process.env.TWILIO_APIKEY_SECRET, {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
  });
}

function isConfigured() {
  return client !== null;
}

// `to` must already be E.164 (+<countrycode><number>) -- callers are
// responsible for that, same as callers being responsible for a valid email
// address before calling Resend. Returns the message SID (mirrors
// sendReply/sendAppointmentEmail returning the Resend email id).
async function sendSms(to, body) {
  if (!client) throw new Error('Twilio not configured');
  const message = await client.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body });
  return message.sid;
}

module.exports = { isConfigured, sendSms };
