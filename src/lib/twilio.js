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

// Twilio signs webhooks with the account's auth token (an API key can't do
// it), so the phone receptionist needs TWILIO_AUTH_TOKEN as well. Unset ->
// every webhook is rejected. `url` must be the public URL Twilio was
// configured with, not what Express sees behind Render's proxy.
function validateWebhook(signature, url, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  return !!token && !!signature && Twilio.validateRequest(token, signature, url, params);
}

// ── Receptionist numbers (MCP search/provision/release_voice_number) ──────
// The auth token first: the receptionist can't run without it (webhook
// signatures), so it's always there when numbers matter, and the API key
// has been seen revoked locally. Not tied to TWILIO_FROM_NUMBER either.
function numbersClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid) return null;
  if (process.env.TWILIO_AUTH_TOKEN) return Twilio(sid, process.env.TWILIO_AUTH_TOKEN);
  if (process.env.TWILIO_APIKEY_SID && process.env.TWILIO_APIKEY_SECRET) {
    return Twilio(process.env.TWILIO_APIKEY_SID, process.env.TWILIO_APIKEY_SECRET, { accountSid: sid });
  }
  return null;
}

function canManageNumbers() {
  return numbersClient() !== null;
}

// ponytail: UK mobiles only. They take calls and texts, need no address, and
// the account's approved UK mobile bundle covers them. Another country means
// its own number type and bundle.
async function searchNumbers({ contains } = {}) {
  const found = await numbersClient().availablePhoneNumbers('GB').mobile.list({
    voiceEnabled: true,
    ...(contains && { contains }),
    limit: 5,
  });
  return found.map((n) => n.phoneNumber);
}

// UK numbers must be bought under a Twilio-approved regulatory bundle.
async function buyNumber(phoneNumber, voiceUrl) {
  const client = numbersClient();
  const bundleSid = process.env.TWILIO_BUNDLE_SID
    || (await client.numbers.v2.regulatoryCompliance.bundles.list({ status: 'twilio-approved', limit: 1 }))[0]?.sid;
  const bought = await client.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl,
    voiceMethod: 'POST',
    ...(bundleSid && { bundleSid }),
  });
  return bought.phoneNumber;
}

// Stops the monthly charge. A number already gone from the account is fine.
async function releaseNumber(phoneNumber) {
  const client = numbersClient();
  const [owned] = await client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
  if (owned) await client.incomingPhoneNumbers(owned.sid).remove();
}

module.exports = {
  isConfigured, sendSms, validateWebhook,
  canManageNumbers, searchNumbers, buyNumber, releaseNumber,
};
