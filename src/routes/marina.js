const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/marina');
const cat = require('../controllers/marinaCatalogue');
const guest = require('../controllers/marinaGuest');
const bookings = require('../controllers/marinaBookings');
const docCtrl = require('../controllers/marinaDocuments');
const { guestLimiter } = require('../lib/marinaGuard');

const bookingLimiter = guestLimiter('marina-booking', 10);
const uploadLimiter = guestLimiter('marina-upload', 30);
const enquiryLimiter = guestLimiter('marina-enquiry', 10);
// Raw uploads, parsed per route (the JSON parsers don't touch these types).
const rawDoc = express.raw({ type: ['application/pdf', 'image/jpeg', 'image/png'], limit: '4mb' });
const rawDocSafe = (req, res, next) => rawDoc(req, res, (err) => (err?.status === 413 ? res.status(413).json({ error: 'Files are limited to 4 MB' }) : next(err)));
const rawImage = express.raw({ type: ['image/jpeg', 'image/png'], limit: '4mb' });
const rawImageSafe = (req, res, next) => rawImage(req, res, (err) => (err?.status === 413 ? res.status(413).json({ error: 'Images are limited to 4 MB' }) : next(err)));
const { authenticate, authenticateOrApiKey, requireRole } = require('../middleware/auth');
const { authenticateSailor, optionalSailor } = require('../middleware/sailorAuth');

// Literal segments before '/:id' throughout (see eventInquiries.js).

// Interim Sidon link, removed at cleanup.
router.put('/key', authenticate, requireRole('admin'), ctrl.setSidonMarinaKey);
router.post('/key/clear', authenticate, requireRole('admin'), ctrl.clearSidonMarinaKey);

router.get('/public', cat.listPublicMarinas);
router.get('/public/:id/berths', guest.getPublicBerths);
router.get('/marinas', authenticateOrApiKey, cat.listMarinas);
router.post('/marinas', authenticateOrApiKey, cat.createMarina);
router.get('/marinas/:id', authenticateOrApiKey, cat.getMarina);
router.put('/marinas/:id', authenticateOrApiKey, cat.updateMarina);

router.post('/marinas/:marina_id/berths/bulk', authenticateOrApiKey, cat.bulkBerths);
router.post('/marinas/:marina_id/images/upload', authenticateOrApiKey, rawImageSafe, cat.uploadImage);
for (const kind of Object.keys(cat.TABLES)) {
  const h = cat.childHandlers(kind);
  router.get(`/marinas/:marina_id/${kind}`, authenticateOrApiKey, h.list);
  router.post(`/marinas/:marina_id/${kind}`, authenticateOrApiKey, h.create);
  router.put(`/marinas/:marina_id/${kind}/:id`, authenticateOrApiKey, h.update);
}

// Guest rail -- the only prefix a site's forwarder passes through -- and the
// Before the loop below, or /sailor/:marina_id would take 'bookings' as an id.
router.get('/sailor/bookings', authenticateSailor, guest.listSailorBookings);
router.get('/sailor/bookings/ably-token', authenticateSailor, guest.sailorAblyToken);
// sailor rail: Sidon books any marina by id, the X-Sailor-Token's verified
// email standing in for a site key.
for (const [G, ...entry] of [
  ['/guest/:marina', authenticateOrApiKey, guest.resolveMarina],
  ['/sailor/:marina_id', authenticateSailor, guest.sailorMarina],
]) {
  router.get(G, ...entry, guest.getMarinaMap);
  router.get(`${G}/availability`, ...entry, guest.getAvailability);
  router.get(`${G}/doc-requirements`, ...entry, guest.getDocRequirements);
  // X-Sailor-Token (Clerk) optional: shared sailor documents.
  router.get(`${G}/requirements-status`, ...entry, optionalSailor, guest.requirementsStatus);
  router.post(`${G}/quote`, ...entry, guest.quote);

  router.post(`${G}/bookings`, ...entry, bookingLimiter, optionalSailor, guest.createGuestBooking);
  router.get(`${G}/bookings/:id`, ...entry, guest.requireBookingToken, guest.getGuestBooking);
  router.post(`${G}/bookings/:id/cancel`, ...entry, guest.requireBookingToken, guest.cancelGuestBooking);
  router.get(`${G}/bookings/:id/ably-token`, ...entry, guest.requireBookingToken, guest.ablyToken);
  router.post(`${G}/bookings/:id/confirm-payment`, ...entry, guest.requireBookingToken, guest.confirmPayment);
  router.post(`${G}/bookings/:id/documents`, ...entry, uploadLimiter, guest.requireBookingToken, rawDocSafe, docCtrl.uploadDocument);

  router.get(`${G}/contract-preview`, ...entry, guest.contractPreview);
  router.post(`${G}/bookings/:id/contract`, ...entry, guest.requireBookingToken, guest.agreeContract);
  router.post(`${G}/enquiries`, ...entry, enquiryLimiter, guest.createEnquiry);
}

// Unauthenticated: the emailed confirm link (spa pattern).
router.get('/confirm-booking/:id/:confirmToken', guest.confirmBookingLink);

// Bearer only: passport data never reaches the key rail (guest sites hold the key).
router.get('/bookings/:id/documents', authenticate, docCtrl.listBookingDocuments);
router.get('/bookings/:id/verification', authenticate, docCtrl.getBookingVerification);
router.put('/documents/:id', authenticate, docCtrl.updateDocument);
// Shared sailor documents (bearer only, like the per-booking ones).
router.get('/sailor-versions/:id/file', authenticate, docCtrl.streamSailorVersion);
router.put('/bookings/:id/sailor-versions/:versionId', authenticate, docCtrl.decideSailorVersion);

router.get('/bookings', authenticateOrApiKey, bookings.listBookings);
router.post('/bookings', authenticateOrApiKey, bookings.createBooking);
router.get('/bookings/:id', authenticateOrApiKey, bookings.getBooking);
router.put('/bookings/:id', authenticateOrApiKey, bookings.updateBooking);
router.post('/bookings/:id/send-guest-link', authenticateOrApiKey, bookings.sendGuestLink);

module.exports = router;
