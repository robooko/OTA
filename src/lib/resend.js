const { Resend } = require('resend');

let client = null;
if (process.env.RESEND_API_KEY) {
  client = new Resend(process.env.RESEND_API_KEY);
}

async function sendReply(inquiry, propertyName, body) {
  if (!client) throw new Error('Resend not configured');
  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <inquiries@hotal.forge-build.co.uk>`,
    to: inquiry.email,
    reply_to: `inquiry+${inquiry.id}@replies.hotal.forge-build.co.uk`,
    subject: 'Re: Your event inquiry',
    text: body,
  });
  if (error) throw new Error(error.message);
  return data.id;
}

function verifyInboundWebhook(payload, headers) {
  if (!client) throw new Error('Resend not configured');
  return client.webhooks.verify({
    payload,
    headers: {
      id: headers['svix-id'],
      timestamp: headers['svix-timestamp'],
      signature: headers['svix-signature'],
    },
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  });
}

async function getReceivedEmail(emailId) {
  const { data, error } = await client.emails.receiving.get(emailId);
  if (error) throw new Error(error.message);
  return data;
}

module.exports = { sendReply, verifyInboundWebhook, getReceivedEmail };
