const QRCode = require('qrcode');
const { Resend } = require('resend');
const pool = require('../db');
const { bookingToken } = require('./marinaToken');

// Guest emails for marina bookings, in the booking's locale (copy ported
// from sidon-marina src/lib/email.ts, extended to every status). Every
// email links to the marina's booking page, with a QR of the same link,
// when booking_url is set. The raw booking token only ever goes to the
// booking's own contact_email.

const client = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const COPY = {
  en: {
    hi: 'Hi', berth: 'Berth', dates: 'Dates', boat: 'Boat', total: 'Total',
    view: 'View your booking', scan: 'Scan to follow on mobile',
    confirmLabel: 'Confirm your email', confirmText: 'Please confirm your email address to send your request to the marina:',
    received: { subject: 'Booking request received', lead: 'We have your request. Confirm your email below and we will send it to the marina.' },
    pending: { subject: 'Booking request sent to the marina', lead: 'Your request is with the marina. You will hear back within {hours} hours.' },
    confirmed: { subject: 'Booking confirmed', lead: 'Your berth is confirmed.' },
    declined: { subject: 'Booking request declined', lead: 'Sorry, the marina could not accept this request. Any card hold has been released.' },
    cancelled: { subject: 'Booking cancelled', lead: 'Your booking has been cancelled.' },
    expired: { subject: 'Booking request expired', lead: 'The marina did not reply in time, so the request has lapsed. Any card hold has been released.' },
    link: { subject: 'Your booking', lead: 'Use the link below to view your booking, upload your documents and sign the contract.' },
  },
  it: {
    hi: 'Ciao', berth: 'Posto barca', dates: 'Date', boat: 'Barca', total: 'Totale',
    view: 'Vedi la tua prenotazione', scan: 'Scansiona per seguire da mobile',
    confirmLabel: 'Conferma la tua email', confirmText: 'Conferma il tuo indirizzo email per inviare la richiesta al porto:',
    received: { subject: 'Richiesta di prenotazione ricevuta', lead: 'Abbiamo ricevuto la tua richiesta. Conferma la tua email qui sotto e la invieremo al porto.' },
    pending: { subject: 'Richiesta inviata al porto', lead: 'La tua richiesta è stata inviata al porto. Riceverai una risposta entro {hours} ore.' },
    confirmed: { subject: 'Prenotazione confermata', lead: 'Il tuo posto barca è confermato.' },
    declined: { subject: 'Richiesta di prenotazione rifiutata', lead: 'Purtroppo il porto non ha potuto accettare la richiesta. Eventuali pre-autorizzazioni sulla carta sono state annullate.' },
    cancelled: { subject: 'Prenotazione cancellata', lead: 'La tua prenotazione è stata cancellata.' },
    expired: { subject: 'Richiesta di prenotazione scaduta', lead: 'Il porto non ha risposto in tempo, quindi la richiesta è scaduta. Eventuali pre-autorizzazioni sulla carta sono state annullate.' },
    link: { subject: 'La tua prenotazione', lead: 'Usa il link qui sotto per vedere la prenotazione, caricare i documenti e firmare il contratto.' },
  },
  fr: {
    hi: 'Bonjour', berth: 'Place', dates: 'Dates', boat: 'Bateau', total: 'Total',
    view: 'Voir votre réservation', scan: 'Scannez pour suivre sur mobile',
    confirmLabel: 'Confirmer votre email', confirmText: 'Veuillez confirmer votre adresse email pour envoyer votre demande à la capitainerie :',
    received: { subject: 'Demande de réservation reçue', lead: 'Nous avons bien reçu votre demande. Confirmez votre email ci-dessous et nous la transmettrons à la capitainerie.' },
    pending: { subject: 'Demande transmise à la capitainerie', lead: 'Votre demande est entre les mains de la capitainerie. Vous aurez une réponse sous {hours} heures.' },
    confirmed: { subject: 'Réservation confirmée', lead: 'Votre place est confirmée.' },
    declined: { subject: 'Demande de réservation refusée', lead: "Désolé, la capitainerie n'a pas pu accepter cette demande. Toute empreinte bancaire a été libérée." },
    cancelled: { subject: 'Réservation annulée', lead: 'Votre réservation a été annulée.' },
    expired: { subject: 'Demande de réservation expirée', lead: "La capitainerie n'a pas répondu à temps, la demande a donc expiré. Toute empreinte bancaire a été libérée." },
    link: { subject: 'Votre réservation', lead: 'Utilisez le lien ci-dessous pour voir votre réservation, déposer vos documents et signer le contrat.' },
  },
  es: {
    hi: 'Hola', berth: 'Amarre', dates: 'Fechas', boat: 'Barco', total: 'Total',
    view: 'Ver tu reserva', scan: 'Escanea para seguir desde el móvil',
    confirmLabel: 'Confirma tu email', confirmText: 'Confirma tu dirección de email para enviar tu solicitud a la marina:',
    received: { subject: 'Solicitud de reserva recibida', lead: 'Hemos recibido tu solicitud. Confirma tu email abajo y la enviaremos a la marina.' },
    pending: { subject: 'Solicitud enviada a la marina', lead: 'Tu solicitud está con la marina. Recibirás respuesta en un plazo de {hours} horas.' },
    confirmed: { subject: 'Reserva confirmada', lead: 'Tu amarre está confirmado.' },
    declined: { subject: 'Solicitud de reserva rechazada', lead: 'Lo sentimos, la marina no ha podido aceptar esta solicitud. Cualquier retención en la tarjeta ha sido liberada.' },
    cancelled: { subject: 'Reserva cancelada', lead: 'Tu reserva ha sido cancelada.' },
    expired: { subject: 'Solicitud de reserva caducada', lead: 'La marina no respondió a tiempo, así que la solicitud ha caducado. Cualquier retención en la tarjeta ha sido liberada.' },
    link: { subject: 'Tu reserva', lead: 'Usa el enlace de abajo para ver tu reserva, subir tus documentos y firmar el contrato.' },
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bookingLink(b) {
  return b.booking_url ? b.booking_url.replace('{id}', b.id).replace('{token}', bookingToken(b.id)) : null;
}

// `b` is the joined row from marinaQueries.joinedBooking. Never throws.
async function sendGuestEmail(b, kind, { confirmUrl } = {}) {
  try {
    if (!client || !b.contact_email) return;
    const t = COPY[b.locale] ?? COPY.en;
    const { rows: [p] } = await pool.query('SELECT name, email_branding FROM property WHERE id = $1', [b.property_id]);
    const branding = p.email_branding || {};
    const link = bookingLink(b);
    // Inline CID attachment, not a data: URI -- Gmail/Outlook strip those.
    // Per-booking CID so one thread doesn't dedupe the images.
    const qrCid = `qr-${b.id}@marina`;
    const qr = link ? await QRCode.toBuffer(link, { errorCorrectionLevel: 'M', margin: 2, width: 320 }).catch(() => null) : null;
    const lead = t[kind].lead.replace('{hours}', b.response_window_hours ?? 24);
    const dates = `${b.arrival} → ${b.departure ?? '…'}`;
    const total = b.total_price != null ? `${b.total_price} ${b.currency}` : null;

    const lines = [`${t.hi} ${b.contact_name},`, '', lead, '', `${t.berth}: ${b.berth_label} — ${b.marina_name}`, `${t.dates}: ${dates}`,
      ...(b.boat_name ? [`${t.boat}: ${b.boat_name}`] : []), ...(total ? [`${t.total}: ${total}`] : []), ''];
    if (confirmUrl) lines.push(t.confirmText, confirmUrl, '');
    if (link) lines.push(`${t.view}: ${link}`);

    const button = (url, label) => `<p style="margin:20px 0"><a href="${esc(url)}" style="display:inline-block;background:${esc(branding.brand_color || '#1a1a1a')};color:#ffffff;text-decoration:none;font-weight:600;padding:10px 22px;border-radius:6px">${esc(label)}</a></p>`;
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto">
      ${branding.logo_url ? `<div style="background:${esc(branding.header_bg || '#ffffff')};padding:12px 0"><img src="${esc(branding.logo_url)}" alt="${esc(p.name)}" style="max-height:48px"></div>` : ''}
      <p>${esc(t.hi)} ${esc(b.contact_name)},</p><p>${esc(lead)}</p>
      <div style="background:#f6f6f4;border-radius:8px;padding:16px 20px">
        <div><strong>${esc(t.berth)}:</strong> ${esc(b.berth_label)} — ${esc(b.marina_name)}</div>
        <div><strong>${esc(t.dates)}:</strong> ${esc(dates)}</div>
        ${b.boat_name ? `<div><strong>${esc(t.boat)}:</strong> ${esc(b.boat_name)}</div>` : ''}
        ${total ? `<div><strong>${esc(t.total)}:</strong> ${esc(total)}</div>` : ''}
      </div>
      ${confirmUrl ? `<p>${esc(t.confirmText)}</p>${button(confirmUrl, t.confirmLabel)}` : ''}
      ${link ? button(link, t.view) : ''}
      ${qr ? `<p style="color:#555;font-size:12px">${esc(t.scan)}</p><p><img src="cid:${qrCid}" alt="" width="160" height="160"></p>` : ''}
    </div>`;

    const { error } = await client.emails.send({
      from: `${p.name} via Forge <bookings@hotal.forge-build.co.uk>`,
      to: b.contact_email,
      ...(b.marina_email ? { replyTo: b.marina_email } : {}),
      subject: `${t[kind].subject} — ${b.marina_name}`,
      text: lines.join('\n'),
      html,
      ...(qr ? { attachments: [{ filename: 'booking-qr.png', content: qr, contentType: 'image/png', contentId: qrCid }] } : {}),
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`Marina ${kind} email failed for ${b.id}:`, err.message);
  }
}

module.exports = { sendGuestEmail, bookingLink, COPY };
