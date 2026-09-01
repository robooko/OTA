function requireFields(fields) {
  return (req, res, next) => {
    const missing = fields.filter((f) => req.body[f] === undefined || req.body[f] === null || req.body[f] === '');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }
    next();
  };
}

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

function isValidUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function isValidTime(str) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

function isValidCurrencyCode(str) {
  return /^[A-Z]{3}$/.test(str);
}

function isValidTimezone(str) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: str });
    return true;
  } catch {
    return false;
  }
}

function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

// Validates the optional caller-supplied {logo_url, brand_color, header_bg}
// used to style booking confirmation/cancellation emails. Relayed as-is on
// spa appointment requests, and kept on an event_inquiry row (only as long
// as the thread lives) so a booking made later from an AI reply can still be
// branded. header_bg paints behind the logo so a dark-ink logo stays legible
// in dark-mode email clients. Returns an error string, or null when
// `branding` is absent/valid.
function validateBranding(branding) {
  if (branding === undefined || branding === null) return null;
  if (typeof branding !== 'object' || Array.isArray(branding)) return 'branding must be an object';
  const { logo_url, brand_color, header_bg } = branding;
  if (logo_url !== undefined && !isValidUrl(logo_url)) return 'branding.logo_url must be a valid http(s) URL';
  if (brand_color !== undefined && !HEX_COLOR_RE.test(brand_color)) {
    return 'branding.brand_color must be a hex color, e.g. #1a1a1a';
  }
  if (header_bg !== undefined && !HEX_COLOR_RE.test(header_bg)) {
    return 'branding.header_bg must be a hex color, e.g. #ffffff';
  }
  return null;
}

// cancel_url may be a template containing {id}, filled in with the
// appointment id when it's created (spa.js publishAndEmailAfterCreate) --
// the caller can't know the id up front, and an enquiry is taken before any
// appointment exists at all. Braces are legal in a URL path, so the plain
// URL check covers both forms.
function validateCancelUrl(cancelUrl) {
  if (cancelUrl === undefined || cancelUrl === null) return null;
  if (!isValidUrl(cancelUrl)) return 'cancel_url must be a valid http(s) URL (may contain {id})';
  return null;
}

module.exports = {
  requireFields, isValidDate, isValidUuid, isValidTime, isValidCurrencyCode, isValidTimezone, isValidUrl,
  validateBranding, validateCancelUrl,
};
