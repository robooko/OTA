// OTA's adapter over @forgebuild/ai-replies (packages/ai-replies): renders
// this property's venue facts (restaurant, spa menu and hours, return
// instructions), wires the availability tool and the spa booking proposal,
// and keeps the result shape the pipeline has always consumed. The prompt
// rules, schema, tool loop and output guards live in the package --
// controllers and the pipeline import this, never the package or SDK directly.
const { z } = require('zod');
const {
  generateReply, neutraliseTags, isConfigured, findCorruption, AiReplyError, MODEL, EFFORT,
} = require('@forgebuild/ai-replies');
const { buildAvailabilityTool, executeAvailabilityTool } = require('./aiReplyTools');

// OTA-only prompt section, frozen: appended after the package's base rules.
const RULES = `RETURNS
- When <inquiry> contains a <return> block, the guest is returning shop items from a paid order. Confirm which items and the order reference, relay <return_instructions> from the venue section if present (do not invent a postal address, deadline or refund timing that isn't there), and never propose a booking. If the venue has no return instructions, say the team will follow up with next steps and set requires_human to true.`;

// A proposal is only bookable against a spa diary; the pipeline drops it for
// anything else (lib/aiReplyPipeline.js generateDraft).
const BookingProposal = z.object({
  treatment_name: z.string().describe('The treatment\'s exact name as the venue lists it in check_availability results.'),
  date: z.iso.date().describe('The booking date, YYYY-MM-DD.'),
  time: z.string().describe('The booking start time, HH:MM 24-hour.'),
});

const CURRENCY_SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };

function money(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency];
  const value = Number(amount).toFixed(2).replace(/\.00$/, '');
  return symbol ? `${symbol}${value}` : `${value} ${currency ?? ''}`.trim();
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ISODOW 1-7

// The inside of <venue>. Stable between calls for the same property, so it
// stays in the cached prefix. A spa's services, prices, contact details and
// hours are rendered here from the DB -- the model's fact source for them,
// so ai_reply_instructions doesn't have to duplicate the database.
function buildVenueFacts(property, restaurant, spa) {
  let text = '';
  if (restaurant) {
    text += `  <restaurant name="${neutraliseTags(restaurant.name)}">`;
    if (restaurant.description) text += neutraliseTags(restaurant.description);
    text += '</restaurant>\n';
  }
  if (spa) {
    text += `  <spa name="${neutraliseTags(spa.name)}">\n`;
    if (spa.description) text += `    ${neutraliseTags(spa.description)}\n`;
    if (spa.address) text += `    Address: ${neutraliseTags(spa.address)}\n`;
    if (spa.phone) text += `    Phone: ${neutraliseTags(spa.phone)}\n`;
    // check_availability already hides times inside it; stating it stops a
    // reply promising "later today" when the salon needs more notice.
    if (spa.lead_time_hours) text += `    Bookings need at least ${spa.lead_time_hours} hours' notice.\n`;
    if (spa.treatments?.length) {
      text += '    Services (duration, price):\n';
      for (const t of spa.treatments) {
        const standard = t.price != null ? money(t.price, property.currency) : 'regulars only';
        const regulars = t.member_price != null
          ? ` (regulars' rate ${money(t.member_price, property.currency)}${t.member_duration_mins ? `, ${t.member_duration_mins} min` : ''})`
          : '';
        // A treatment the venue only offers on some days -- check_availability
        // already returns nothing for the others, but saying so here stops a
        // reply offering a day it would then have to take back.
        const days = t.days_of_week?.length
          ? ` -- only on ${t.days_of_week.map((d) => DAY_NAMES[d - 1]).join(', ')}`
          : '';
        text += `      ${neutraliseTags(t.name)} -- ${t.duration_mins} min -- ${standard}${regulars}${days}\n`;
      }
      // A booking made from a reply can't verify the guest is a regular
      // (lib/spaMemberRate.js), so it always books at the standard price
      // and a regulars-only service can't be booked this way at all.
      if (spa.treatments.some((t) => t.member_price != null)) {
        text += "    The regulars' rate applies to clients whose last visit was within the past 4 weeks, and only when they book online while signed in. Never propose booking a regulars-only service.\n";
      }
    }
    if (spa.hours?.length) {
      const byTherapist = new Map();
      for (const h of spa.hours) {
        if (!byTherapist.has(h.therapist_name)) byTherapist.set(h.therapist_name, []);
        byTherapist.get(h.therapist_name).push(`${DAY_NAMES[h.day_of_week - 1]} ${h.start_time.slice(0, 5)}-${h.end_time.slice(0, 5)}`);
      }
      for (const [name, days] of byTherapist) {
        text += `    Hours (${neutraliseTags(name)}): ${days.join('; ')}. Other days closed.\n`;
      }
    }
    text += '  </spa>\n';
  }
  if (property.return_instructions?.trim()) {
    text += `  <return_instructions>${neutraliseTags(property.return_instructions.trim())}</return_instructions>\n`;
  }
  return text;
}

function renderReturn(returnRequest) {
  let text = `  <return order_reference="${neutraliseTags(returnRequest.reference)}" status="${neutraliseTags(returnRequest.status)}">\n`;
  for (const line of returnRequest.items) {
    text += `    <line quantity="${line.quantity}">${neutraliseTags(line.item_name)}</line>\n`;
  }
  if (returnRequest.reason) text += `    <reason>${neutraliseTags(returnRequest.reason)}</reason>\n`;
  text += '  </return>\n';
  return text;
}

// Returns { proposed_booking, body, quality_score, requires_human,
// requires_human_reason, summary, model, usage } or throws AiReplyError.
async function generateInquiryReply({ property, inquiry, restaurant = null, spa = null, thread = [], triggerType = 'manual', today, returnRequest = null }) {
  const definition = buildAvailabilityTool(inquiry);
  const result = await generateReply({
    venue: { name: property.name, facts: buildVenueFacts(property, restaurant, spa), instructions: property.ai_reply_instructions },
    rules: RULES,
    availabilityTool: definition ? { definition, execute: (input) => executeAvailabilityTool(inquiry, input) } : null,
    bookingSchema: BookingProposal,
    inquiry: {
      name: inquiry.name,
      fields: {
        event_date: inquiry.event_date, event_time: inquiry.event_time, guests: inquiry.guests,
        event_type: inquiry.event_type, format: inquiry.format,
      },
      message: inquiry.message,
      extra: returnRequest ? renderReturn(returnRequest) : undefined,
    },
    thread,
    triggerType,
    today,
  });

  // All-or-nothing: a missing or malformed field means no booking happens on
  // approval (the draft then reads as an over-promise a reviewer can catch,
  // rather than us booking something half-specified).
  const p = result.proposed_booking;
  const treatment = p?.treatment_name?.trim();
  const proposedBooking = treatment && /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '') && /^\d{2}:\d{2}$/.test(p.time ?? '')
    ? { treatment_name: treatment, date: p.date, time: p.time }
    : null;
  return { ...result, proposed_booking: proposedBooking };
}

module.exports = { isConfigured, generateInquiryReply, findCorruption, AiReplyError, MODEL, EFFORT };
