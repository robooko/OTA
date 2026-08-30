const { Resend } = require('resend');

let client = null;
if (process.env.RESEND_API_KEY) {
  client = new Resend(process.env.RESEND_API_KEY);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

// event_inquiry_message rows don't include the guest's original inquiry text
// (that lives on event_inquiry.message) -- prepend it here so "conversation
// history" in the email actually starts at the beginning of the thread.
// Oldest-first, matching the dashboard's reply-thread order.
function buildHistoryEntries(inquiry, priorMessages) {
  const entries = [];
  if (inquiry.message) {
    entries.push({ sender: inquiry.name, date: inquiry.created_at, body: inquiry.message });
  }
  for (const m of priorMessages) {
    entries.push({
      sender: m.direction === 'inbound' ? inquiry.name : m.sent_by_name || 'Staff',
      date: m.created_at,
      body: m.body,
    });
  }
  return entries;
}

function textToHtmlParagraphs(text) {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function buildHistoryHtml(entries) {
  if (!entries.length) return '';
  const items = entries
    .map(
      (e) => `
        <div style="margin:0 0 16px;padding-left:12px;border-left:2px solid #d0d0d0;">
          <div style="font-size:12px;color:#666;margin-bottom:4px;">
            <strong>${escapeHtml(e.sender)}</strong> &middot; ${formatDate(e.date)}
          </div>
          <div style="font-size:13px;color:#444;">${textToHtmlParagraphs(e.body)}</div>
        </div>`
    )
    .join('');
  return `
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e0e0e0;">
      <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Previous messages</div>
      ${items}
    </div>`;
}

function buildHistoryText(entries) {
  if (!entries.length) return '';
  const items = entries.map((e) => `${e.sender} (${formatDate(e.date)}):\n${e.body}`).join('\n\n');
  return `\n\n---\nPrevious messages:\n\n${items}`;
}

async function sendReply(inquiry, propertyName, body, priorMessages = []) {
  if (!client) throw new Error('Resend not configured');
  const history = buildHistoryEntries(inquiry, priorMessages);
  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <inquiries@hotal.forge-build.co.uk>`,
    to: inquiry.email,
    replyTo: `inquiry+${inquiry.id}@${process.env.RESEND_REPLY_DOMAIN}`,
    // Not "event inquiry": the module also carries group-booking and general
    // enquiries (see 2026-08-30-general-inquiries-design.md).
    subject: `Re: Your enquiry to ${propertyName}`,
    text: `${body}${buildHistoryText(history)}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;max-width:600px;">${textToHtmlParagraphs(
      body
    )}${buildHistoryHtml(history)}</div>`,
  });
  if (error) throw new Error(error.message);
  return data.id;
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(amount);
  } catch {
    return `${amount}`;
  }
}

// appointment.appointment_date comes back from pg as a JS Date (DATE column);
// start_time as a 'HH:MM:SS' string (TIME column) -- normalise both into
// display strings without going through a timezone-aware Date parse, since
// neither column carries a timezone (same reasoning as toLiveSpaBooking's
// start_time in src/controllers/spa.js).
function formatAppointmentDate(appointmentDate) {
  const iso = appointmentDate instanceof Date ? appointmentDate.toISOString().slice(0, 10) : appointmentDate;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Shared by sendAppointmentConfirmation/sendAppointmentCancellation. `verb`
// is 'confirmed' or 'cancelled'; `extraLines` go after the booking details,
// before the address/phone block.
async function sendAppointmentEmail(appointment, propertyName, verb, extraLines) {
  if (!client) throw new Error('Resend not configured');
  const dateLabel = formatAppointmentDate(appointment.appointment_date);
  const timeLabel = appointment.start_time.slice(0, 5);
  const price = formatMoney(appointment.price, appointment.property_currency);
  const subject = `Booking ${verb} — ${appointment.treatment_name}, ${dateLabel} at ${timeLabel}`;

  const lines = [
    `Hi ${appointment.contact_name},`,
    '',
    `${appointment.treatment_name} with ${appointment.therapist_name}`,
    `${dateLabel} at ${timeLabel} (${appointment.duration_mins} mins) — ${price}`,
    '',
    ...extraLines,
  ];
  if (appointment.spa_address) lines.push(appointment.spa_address);
  if (appointment.spa_phone) lines.push(appointment.spa_phone);
  const text = lines.join('\n');

  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <bookings@hotal.forge-build.co.uk>`,
    to: appointment.contact_email,
    ...(appointment.spa_contact_email ? { replyTo: appointment.spa_contact_email } : {}),
    subject,
    text,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;">${textToHtmlParagraphs(text)}</div>`,
  });
  if (error) throw new Error(error.message);
  return data.id;
}

// `appointment` is the joined shape from spa.js's getFullAppointmentForEmail:
// sa.* plus therapist_name, treatment_name, duration_mins, price, spa_address,
// spa_phone, spa_contact_email, property_currency. Never throws for a missing
// contact_email -- callers only invoke this when one is present.
function sendAppointmentConfirmation(appointment, propertyName) {
  return sendAppointmentEmail(appointment, propertyName, 'confirmed', [
    'Need to change or cancel? Just give us a call.',
    '',
  ]);
}

function sendAppointmentCancellation(appointment, propertyName) {
  return sendAppointmentEmail(appointment, propertyName, 'cancelled', [
    'This booking has been cancelled. Get in touch if that was a mistake, or to book another time.',
    '',
  ]);
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

module.exports = {
  sendReply,
  sendAppointmentConfirmation,
  sendAppointmentCancellation,
  verifyInboundWebhook,
  getReceivedEmail,
};
