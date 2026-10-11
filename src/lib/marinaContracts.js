const { nightsBetween } = require('./marinaPricing');

// Merge fields keep Sidon's names so imported templates render unchanged.
// Document-field placeholders ({{acord25.*}}, {{insurance.*}}) are not
// supported in phase 1 and render blank; the template editor warns.
const FIELDS = ['sailor_name', 'sailor_email', 'boat_name', 'boat_loa', 'boat_beam', 'berth_id', 'arrival_date', 'departure_date',
  'nights', 'amount', 'notes', 'marina_name', 'marina_email', 'marina_phone', 'marina_website', 'today'];
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

const pickTemplate = (templates, nights) =>
  templates.filter((t) => t.min_nights <= nights).sort((a, b) => b.min_nights - a.min_nights)[0] ?? null;

const renderContract = (body, ctx) => body.replace(PLACEHOLDER, (_, k) => (ctx[k] == null ? '' : String(ctx[k])));

const unknownPlaceholders = (body) => [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((k) => !FIELDS.includes(k)))];

function contractContext(b, today) {
  return {
    sailor_name: b.contact_name, sailor_email: b.contact_email, boat_name: b.boat_name,
    boat_loa: b.boat_length_m, boat_beam: b.boat_beam_m, berth_id: b.berth_label,
    arrival_date: b.arrival, departure_date: b.departure,
    nights: b.departure ? nightsBetween(b.arrival, b.departure) : null,
    amount: b.total_price != null ? `${b.total_price} ${b.currency}` : null, notes: b.notes,
    marina_name: b.marina_name, marina_email: b.marina_email, marina_phone: b.marina_phone, marina_website: b.marina_website,
    today,
  };
}

module.exports = { FIELDS, pickTemplate, renderContract, unknownPlaceholders, contractContext };
