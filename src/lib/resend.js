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

// The out-of-tokens fallback for an AI reply: hand the enquiry to the venue's
// own inbox instead. Reply-To is the guest, so answering from the mail
// client goes straight to them -- that reply never passes through OTA, which
// is the "poor alternative" a token would have bought them out of.
// `latestMessage` is the inbound guest reply that triggered this (null on a
// brand-new enquiry, whose text is inquiry.message).
async function sendInquiryForward(inquiry, propertyName, toEmail, latestMessage = null) {
  if (!client) throw new Error('Resend not configured');
  const details = [
    ['Name', inquiry.name],
    ['Email', inquiry.email],
    ['Phone', inquiry.phone],
    ['Date', inquiry.event_date ? formatAppointmentDate(inquiry.event_date) : null],
    ['Time', inquiry.event_time ? String(inquiry.event_time).slice(0, 5) : null],
    ['Guests', inquiry.guests],
    ['Type', [inquiry.event_type, inquiry.format].filter(Boolean).join(' / ') || null],
  ].filter(([, v]) => v != null && v !== '');
  const body = latestMessage ?? inquiry.message ?? '';
  const heading = latestMessage ? `${inquiry.name} replied to their enquiry` : `New enquiry from ${inquiry.name}`;
  const note = 'This was sent to you because your Forge account is out of AI reply tokens. Reply to this email to answer the guest directly, or top up under Settings > Billing to have replies drafted for you.';

  const { data, error } = await client.emails.send({
    from: `Forge <inquiries@hotal.forge-build.co.uk>`,
    to: toEmail,
    replyTo: inquiry.email,
    subject: `${heading} — ${propertyName}`,
    text: `${heading}\n\n${details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${body}\n\n---\n${note}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;max-width:600px;">
      <h2 style="font-size:16px;margin:0 0 12px;">${escapeHtml(heading)}</h2>
      <table style="border-collapse:collapse;margin:0 0 16px;font-size:13px;">${details
        .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666;">${escapeHtml(k)}</td><td style="padding:2px 0;">${escapeHtml(v)}</td></tr>`)
        .join('')}</table>
      ${textToHtmlParagraphs(body)}
      <p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #e0e0e0;font-size:12px;color:#888;">${escapeHtml(note)}</p>
    </div>`,
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
// before the address/phone block. Booking text is always generated here --
// `branding` (caller-supplied {logo_url, brand_color, header_bg}, validated
// by spa.js's validateBranding) only affects the HTML header's logo/colors,
// and `cancelUrl` (validated http(s) URL) only adds a cancel link/button --
// neither is persisted, and neither can touch the booking text itself.
async function sendAppointmentEmail(appointment, propertyName, verb, extraLines, branding, cancelUrl) {
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
  if (cancelUrl) lines.push(`Cancel your booking: ${cancelUrl}`, '');
  if (appointment.spa_address) lines.push(appointment.spa_address);
  if (appointment.spa_phone) lines.push(appointment.spa_phone);
  const text = lines.join('\n');

  // HTML version: same content as `text`, laid out as header / greeting /
  // details card / note / cancel button / muted footer. Plain-text part
  // above stays the single source of the wording.
  const accentColor = branding?.brand_color || '#e0e0e0';
  // header_bg paints a box behind the logo so dark-ink logos survive
  // dark-mode clients (which otherwise leave them on a dark ground).
  const headerBoxStyle = branding?.header_bg
    ? `background:${branding.header_bg};padding:18px;border-radius:8px;`
    : 'padding-bottom:18px;';
  const logoHtml = branding?.logo_url
    ? `<div style="text-align:center;margin-bottom:24px;${headerBoxStyle}border-bottom:3px solid ${accentColor};">
        <img src="${escapeHtml(branding.logo_url)}" alt="${escapeHtml(propertyName)}" style="max-height:64px;max-width:260px;display:inline-block;">
      </div>`
    : '';

  const detailsHtml = `
    <div style="background:#f6f6f4;border-radius:8px;padding:18px 20px;margin:0 0 16px;">
      <div style="font-size:16px;font-weight:600;margin:0 0 4px;">${escapeHtml(appointment.treatment_name)} with ${escapeHtml(appointment.therapist_name)}</div>
      <div style="font-size:14px;color:#555;">${escapeHtml(dateLabel)} at ${escapeHtml(timeLabel)} (${appointment.duration_mins} mins)</div>
      <div style="font-size:15px;font-weight:600;margin-top:10px;">${escapeHtml(price)}</div>
    </div>`;

  const noteHtml = extraLines
    .filter(Boolean)
    .map((l) => `<p style="margin:0 0 12px;">${escapeHtml(l)}</p>`)
    .join('');

  const cancelHtml = cancelUrl
    ? `<div style="margin:20px 0;">
        <a href="${escapeHtml(cancelUrl)}" style="display:inline-block;background:${branding?.brand_color || '#1a1a1a'};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 22px;border-radius:6px;">Cancel booking</a>
      </div>`
    : '';

  const footerParts = [];
  if (appointment.spa_address) footerParts.push(escapeHtml(appointment.spa_address));
  if (appointment.spa_phone) footerParts.push(escapeHtml(appointment.spa_phone));
  const footerHtml = footerParts.length
    ? `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e0e0e0;font-size:12px;color:#888;line-height:1.7;">${footerParts.join('<br>')}</div>`
    : '';

  const { data, error } = await client.emails.send({
    from: `${propertyName} via Forge <bookings@hotal.forge-build.co.uk>`,
    to: appointment.contact_email,
    ...(appointment.spa_contact_email ? { replyTo: appointment.spa_contact_email } : {}),
    subject,
    text,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto;">
      ${logoHtml}
      <p style="margin:0 0 16px;">Hi ${escapeHtml(appointment.contact_name)},</p>
      ${detailsHtml}
      ${noteHtml}
      ${cancelHtml}
      ${footerHtml}
    </div>`,
  });
  if (error) throw new Error(error.message);
  return data.id;
}

// `appointment` is the joined shape from spa.js's getFullAppointmentForEmail:
// sa.* plus therapist_name, treatment_name, duration_mins, price, spa_address,
// spa_phone, spa_contact_email, property_currency. Never throws for a missing
// contact_email -- callers only invoke this when one is present.
function sendAppointmentConfirmation(appointment, propertyName, branding, cancelUrl) {
  return sendAppointmentEmail(appointment, propertyName, 'confirmed', [
    cancelUrl
      ? 'Need to change or cancel? Use the link below.'
      : 'Need to change or cancel? Just give us a call.',
    '',
  ], branding, cancelUrl);
}

function sendAppointmentCancellation(appointment, propertyName, branding) {
  return sendAppointmentEmail(appointment, propertyName, 'cancelled', [
    'This booking has been cancelled. Get in touch if that was a mistake, or to book another time.',
    '',
  ], branding);
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
  sendInquiryForward,
  sendAppointmentConfirmation,
  sendAppointmentCancellation,
  verifyInboundWebhook,
  getReceivedEmail,
};
