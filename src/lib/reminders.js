// Pre-visit reminders for spa appointments and restaurant reservations,
// email and SMS. Same in-process sweep shape as reviewRequester.js (a
// single claiming UPDATE is the idempotency guarantee) but two modules and
// two channels instead of one of each, so channel eligibility -- is it
// enabled on the property, is Twilio even configured, has this contact
// opted out -- is resolved in JS per send rather than folded into the
// claim SQL, which stays a "is a reminder due" test only.
const pool = require('../db');
const { sendSpaReminder, sendReservationReminder, formatAppointmentDate } = require('./resend');
const twilio = require('./twilio');
const { getFullAppointmentForEmail, resolveEmailBranding } = require('../controllers/spa');

// Same public host used for every link that has to work outside a request
// (property.js's VERCEL_CALLBACK_URL, reviewRequester's opt-out links).
const OTA_API_BASE_URL = 'https://ota-u6ii.onrender.com';

const MAX_ATTEMPTS = 3;

const SPA_CLAIM_SQL = `
  UPDATE spa_appointment sa
  SET reminder_sent_at = now(), reminder_attempts = sa.reminder_attempts + 1
  FROM property p
  WHERE p.id = sa.property_id
    AND p.reminder_enabled
    AND sa.status = 'confirmed'
    AND sa.reminder_sent_at IS NULL
    AND sa.reminder_attempts < $1
    AND (sa.contact_email IS NOT NULL OR sa.contact_phone IS NOT NULL)
    -- due within reminder_hours_before, and not already past --
    -- appointment_date/start_time carry no timezone of their own.
    AND (sa.appointment_date + sa.start_time) AT TIME ZONE p.timezone > now()
    AND (sa.appointment_date + sa.start_time) AT TIME ZONE p.timezone
          <= now() + (p.reminder_hours_before || ' hours')::interval
  RETURNING sa.id, sa.property_id, sa.reminder_attempts;
`;

// restaurant_reservation has no timezone of its own -- restaurant.timezone
// (nullable, falls back to property.timezone) is the one that can override.
const RESTAURANT_CLAIM_SQL = `
  UPDATE restaurant_reservation rr
  SET reminder_sent_at = now(), reminder_attempts = rr.reminder_attempts + 1
  FROM property p, restaurant_table rt, restaurant r
  WHERE p.id = rr.property_id
    AND rt.id = rr.table_id
    AND r.id = rt.restaurant_id
    AND p.reminder_enabled
    AND rr.status = 'confirmed'
    AND rr.reminder_sent_at IS NULL
    AND rr.reminder_attempts < $1
    AND (rr.contact_email IS NOT NULL OR rr.contact_phone IS NOT NULL)
    AND (rr.reservation_date + rr.start_time) AT TIME ZONE COALESCE(r.timezone, p.timezone) > now()
    AND (rr.reservation_date + rr.start_time) AT TIME ZONE COALESCE(r.timezone, p.timezone)
          <= now() + (p.reminder_hours_before || ' hours')::interval
  RETURNING rr.id, rr.property_id, rr.reminder_attempts;
`;

async function getFullReservationForEmail(reservationId) {
  const { rows } = await pool.query(
    `SELECT rr.*, r.name AS restaurant_name, r.phone AS restaurant_phone, p.name AS property_name
     FROM restaurant_reservation rr
     JOIN restaurant_table rt ON rt.id = rr.table_id
     JOIN restaurant r ON r.id = rt.restaurant_id
     JOIN property p ON p.id = rr.property_id
     WHERE rr.id = $1`,
    [reservationId]
  );
  return rows[0] || null;
}

async function isOptedOut(propertyId, channel, contact) {
  if (!contact) return true; // nothing to send to -- treat like opted out
  const { rows } = await pool.query(
    'SELECT 1 FROM reminder_opt_out WHERE property_id = $1 AND channel = $2 AND contact = lower($3)',
    [propertyId, channel, contact]
  );
  return rows.length > 0;
}

async function releaseForRetry(table, id) {
  await pool.query(`UPDATE ${table} SET reminder_sent_at = NULL WHERE id = $1`, [id]);
}

function buildSpaSmsBody(appointment, optOutUrl) {
  const dateLabel = formatAppointmentDate(appointment.appointment_date);
  const timeLabel = appointment.start_time.slice(0, 5);
  return `Reminder: ${appointment.treatment_name} with ${appointment.therapist_name}, ${dateLabel} at ${timeLabel} at ${appointment.property_name}. To stop these texts: ${optOutUrl}`;
}

function buildRestaurantSmsBody(reservation, optOutUrl) {
  const dateLabel = formatAppointmentDate(reservation.reservation_date);
  const timeLabel = reservation.start_time.slice(0, 5);
  return `Reminder: table for ${reservation.party_size} at ${reservation.property_name}, ${dateLabel} at ${timeLabel}. To stop these texts: ${optOutUrl}`;
}

// Shared by sendSpaOne/sendRestaurantOne: try email then SMS independently
// (one channel's failure doesn't block the other), track whether anything
// actually sent, and release the claim for retry only when nothing did.
async function sendBothChannels({
  table, id, propertyId, propertySettings, attempts,
  emailAddress, phoneNumber,
  sendEmail, sendSmsFn, markEmailSent, markSmsSent,
}) {
  let anySent = false;
  let anyFailed = false;

  if (propertySettings.reminder_email_enabled && emailAddress && !(await isOptedOut(propertyId, 'email', emailAddress))) {
    try {
      const emailId = await sendEmail();
      await markEmailSent(emailId);
      anySent = true;
    } catch (err) {
      console.error(`Reminder email failed for ${table} ${id}:`, err.message);
      anyFailed = true;
    }
  }

  if (propertySettings.reminder_sms_enabled && twilio.isConfigured() && phoneNumber && !(await isOptedOut(propertyId, 'sms', phoneNumber))) {
    try {
      const sid = await sendSmsFn();
      await markSmsSent(sid);
      anySent = true;
    } catch (err) {
      console.error(`Reminder SMS failed for ${table} ${id}:`, err.message);
      anyFailed = true;
    }
  }

  if (!anySent && anyFailed && attempts < MAX_ATTEMPTS) await releaseForRetry(table, id);
  return anySent;
}

async function sendSpaOne(claimed) {
  const full = await getFullAppointmentForEmail(claimed.id);
  if (!full) return false; // vanished between claim and send

  const { rows: [settings] } = await pool.query(
    'SELECT reminder_email_enabled, reminder_sms_enabled FROM property WHERE id = $1',
    [claimed.property_id]
  );

  return sendBothChannels({
    table: 'spa_appointment',
    id: claimed.id,
    propertyId: claimed.property_id,
    propertySettings: settings,
    attempts: claimed.reminder_attempts,
    emailAddress: full.contact_email,
    phoneNumber: full.contact_phone,
    sendEmail: async () => {
      const { branding } = await resolveEmailBranding(claimed.property_id, undefined, undefined);
      const optOutUrl = `${OTA_API_BASE_URL}/api/spa/reminder-opt-out/${claimed.id}/email`;
      return sendSpaReminder(full, full.property_name, branding, optOutUrl);
    },
    sendSmsFn: () => {
      const optOutUrl = `${OTA_API_BASE_URL}/api/spa/reminder-opt-out/${claimed.id}/sms`;
      return twilio.sendSms(full.contact_phone, buildSpaSmsBody(full, optOutUrl));
    },
    markEmailSent: (emailId) => pool.query('UPDATE spa_appointment SET reminder_email_resend_id = $1 WHERE id = $2', [emailId, claimed.id]),
    markSmsSent: (sid) => pool.query('UPDATE spa_appointment SET reminder_sms_sid = $1 WHERE id = $2', [sid, claimed.id]),
  });
}

async function sendRestaurantOne(claimed) {
  const full = await getFullReservationForEmail(claimed.id);
  if (!full) return false;

  const { rows: [settings] } = await pool.query(
    'SELECT reminder_email_enabled, reminder_sms_enabled FROM property WHERE id = $1',
    [claimed.property_id]
  );

  return sendBothChannels({
    table: 'restaurant_reservation',
    id: claimed.id,
    propertyId: claimed.property_id,
    propertySettings: settings,
    attempts: claimed.reminder_attempts,
    emailAddress: full.contact_email,
    phoneNumber: full.contact_phone,
    sendEmail: async () => {
      const { branding } = await resolveEmailBranding(claimed.property_id, undefined, undefined);
      const optOutUrl = `${OTA_API_BASE_URL}/api/restaurant/reminder-opt-out/${claimed.id}/email`;
      return sendReservationReminder(full, full.property_name, branding, optOutUrl);
    },
    sendSmsFn: () => {
      const optOutUrl = `${OTA_API_BASE_URL}/api/restaurant/reminder-opt-out/${claimed.id}/sms`;
      return twilio.sendSms(full.contact_phone, buildRestaurantSmsBody(full, optOutUrl));
    },
    markEmailSent: (emailId) => pool.query('UPDATE restaurant_reservation SET reminder_email_resend_id = $1 WHERE id = $2', [emailId, claimed.id]),
    markSmsSent: (sid) => pool.query('UPDATE restaurant_reservation SET reminder_sms_sid = $1 WHERE id = $2', [sid, claimed.id]),
  });
}

async function sweep() {
  const [{ rows: spaClaims }, { rows: restaurantClaims }] = await Promise.all([
    pool.query(SPA_CLAIM_SQL, [MAX_ATTEMPTS]),
    pool.query(RESTAURANT_CLAIM_SQL, [MAX_ATTEMPTS]),
  ]);

  let sent = 0;
  for (const row of spaClaims) if (await sendSpaOne(row)) sent++;
  for (const row of restaurantClaims) if (await sendRestaurantOne(row)) sent++;
  return sent;
}

// Boot + every 15 minutes, same pattern as availabilitySeeder/teeTimeSeeder/
// reviewRequester -- fine-grained enough that a reminder goes out within a
// quarter-hour of reminder_hours_before without being a busy loop.
function startReminderJob() {
  const run = () =>
    sweep()
      .then((n) => { if (n > 0) console.log(`Reminders: sent ${n}`); })
      .catch((err) => console.error('Reminder sweep failed:', err.message));
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref();
}

module.exports = { sweep, startReminderJob };
