// Gives the AI reply pipeline (aiReplies.js) a way to check real,
// current availability instead of only ever working from the property's
// static instructions text. Offered as a tool only when the inquiry is
// tagged to a restaurant, spa or marina -- there's nothing concrete to check
// for a general enquiry with none set.
//
// Calls the same lookup functions the REST availability-search endpoints
// use (findRestaurantAvailability / findSpaAvailability), in-process rather
// than over HTTP, so results can never drift from what a guest booking
// directly would see.
const pool = require('../db');
const { isValidDate } = require('../middleware/validate');
const { findRestaurantAvailability } = require('../controllers/restaurant');
const { findSpaAvailability } = require('../controllers/spa');
const marinaQueries = require('./marinaQueries');
const { berthFitError } = require('./marinaGuard');
const { priceStay } = require('./marinaPricing');

const MAX_RESULT_SLOTS = 20;
const TOOL_NAME = 'check_availability';
const MAX_BERTH_OPTIONS = 10;

function buildAvailabilityTool(inquiry) {
  if (!inquiry.restaurant_id && !inquiry.spa_id && !inquiry.marina_id) return null;

  if (inquiry.marina_id) {
    return {
      name: TOOL_NAME,
      description:
        "Check which berths at the marina are free for a stay, and the price of each for that stay. Use this before telling the guest availability is unknown or ruling out dates. Departure is exclusive (the morning they leave). Pass the boat's length (and beam if known) so only berths the boat fits are returned. An empty list really does mean nothing suitable is free.",
      input_schema: {
        type: 'object',
        properties: {
          arrival: { type: 'string', description: 'Arrival date, YYYY-MM-DD.' },
          departure: { type: 'string', description: 'Departure date, YYYY-MM-DD (exclusive).' },
          boat_length_m: { type: 'number', description: "The boat's length overall in metres, if known." },
          boat_beam_m: { type: 'number', description: "The boat's beam in metres, if known." },
        },
        required: ['arrival', 'departure'],
      },
    };
  }

  if (inquiry.restaurant_id) {
    return {
      name: TOOL_NAME,
      description:
        "Check real, live table availability for a date or date range. Use this before telling the guest availability is unknown, before confirming or ruling out a date, and before setting requires_human solely because you don't know availability -- an empty result really does mean nothing is available, not that you lack access to check.",
      input_schema: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'First date to check, YYYY-MM-DD.' },
          date_to: { type: 'string', description: 'Last date to check, YYYY-MM-DD. Same as date_from for a single day.' },
          party_size: { type: 'integer', description: 'Number of guests.' },
        },
        required: ['date_from', 'date_to', 'party_size'],
      },
    };
  }

  return {
    name: TOOL_NAME,
    description:
      "Check real, live appointment availability for a date or date range. Use this before telling the guest availability is unknown, before confirming or ruling out a date, and before setting requires_human solely because you don't know availability -- an empty result really does mean nothing is available, not that you lack access to check. If treatment_name doesn't match, the result lists the real treatment names to retry with.",
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'First date to check, YYYY-MM-DD.' },
        date_to: { type: 'string', description: 'Last date to check, YYYY-MM-DD. Same as date_from for a single day.' },
        treatment_name: {
          type: 'string',
          description: 'The treatment the guest wants, as close to their own wording as possible (e.g. "haircut", "couples massage").',
        },
      },
      required: ['date_from', 'date_to', 'treatment_name'],
    },
  };
}

async function executeAvailabilityTool(inquiry, input) {
  if (inquiry.marina_id) return executeBerthAvailability(inquiry.marina_id, input);
  const date_from = String(input?.date_from ?? '');
  const date_to = String(input?.date_to ?? '');
  if (!isValidDate(date_from) || !isValidDate(date_to)) {
    return { error: 'date_from and date_to must be valid YYYY-MM-DD dates' };
  }
  if (date_from > date_to) return { error: 'date_from must be before or equal to date_to' };

  if (inquiry.restaurant_id) {
    const partySize = Number(input?.party_size);
    if (!Number.isInteger(partySize) || partySize <= 0) {
      return { error: 'party_size must be a positive integer' };
    }
    const slots = await findRestaurantAvailability(inquiry.restaurant_id, date_from, date_to, partySize);
    return { slots: slots.slice(0, MAX_RESULT_SLOTS) };
  }

  // Spa: the model only knows the treatment by name, not id -- resolve it
  // against this spa's active treatments, matching loosely in either
  // direction (guest wording vs. the venue's own name for it) since neither
  // side reliably says it the same way.
  const { rows: treatments } = await pool.query(
    "SELECT id, name FROM spa_treatment WHERE spa_id = $1 AND status = 'active'",
    [inquiry.spa_id]
  );
  const wanted = String(input?.treatment_name ?? '').trim().toLowerCase();
  // Exact name first: with a menu like "Haircut" / "Kids Haircut (under 12)"
  // the substring pass alone can never uniquely resolve "haircut", so the
  // most common request would always error out as ambiguous.
  let matches = wanted ? treatments.filter((t) => t.name.toLowerCase() === wanted) : [];
  if (wanted && !matches.length) {
    matches = treatments.filter((t) => {
      const name = t.name.toLowerCase();
      return name.includes(wanted) || wanted.includes(name);
    });
  }
  if (matches.length !== 1) {
    return {
      error: matches.length > 1 ? 'treatment_name matched more than one treatment' : 'treatment_name did not match a treatment',
      available_treatments: treatments.map((t) => t.name),
    };
  }

  const slots = await findSpaAvailability(inquiry.spa_id, date_from, date_to, matches[0].id, null);
  return { treatment: matches[0].name, slots: slots.slice(0, MAX_RESULT_SLOTS) };
}

// Same lookups as GET /api/marina/guest/:marina/availability.
async function executeBerthAvailability(marinaId, input) {
  const arrival = String(input?.arrival ?? '');
  const departure = String(input?.departure ?? '');
  if (!isValidDate(arrival) || !isValidDate(departure)) return { error: 'arrival and departure must be valid YYYY-MM-DD dates' };
  if (departure <= arrival) return { error: 'departure must be after arrival' };
  const len = Number(input?.boat_length_m) > 0 ? Number(input.boat_length_m) : null;
  const beam = Number(input?.boat_beam_m) > 0 ? Number(input.boat_beam_m) : null;
  const [berths, tiers] = await Promise.all([
    marinaQueries.freeBerths(pool, marinaId, arrival, departure),
    marinaQueries.activeTiers(pool, marinaId),
  ]);
  const fits = len ? berths.filter((b) => !berthFitError(b, len, beam)) : berths;
  return {
    free_berths: fits.length,
    options: fits.slice(0, MAX_BERTH_OPTIONS).map((b) => {
      const { nights, total_price } = priceStay({ berth: b, tiers, arrival, departure, boatLengthM: len, boatBeamM: beam });
      return { label: b.label, length_m: b.length_m, beam_m: b.beam_m, nights, total_price };
    }),
  };
}

module.exports = { buildAvailabilityTool, executeAvailabilityTool };
