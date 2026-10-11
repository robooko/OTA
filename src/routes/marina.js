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
const { authenticate, authenticateOrApiKey, requireRole } = require('../middleware/auth');

// Literal segments before '/:id' throughout (see eventInquiries.js).

// Interim Sidon link, removed at cleanup / Switch.
router.put('/key', authenticate, requireRole('admin'), ctrl.setSidonMarinaKey);
router.post('/key/clear', authenticate, requireRole('admin'), ctrl.clearSidonMarinaKey);
router.get('/sidon-bookings', authenticateOrApiKey, ctrl.listMarinaBookings);

router.get('/marinas', authenticateOrApiKey, cat.listMarinas);
router.post('/marinas', authenticateOrApiKey, cat.createMarina);
router.get('/marinas/:id', authenticateOrApiKey, cat.getMarina);
router.put('/marinas/:id', authenticateOrApiKey, cat.updateMarina);

router.post('/marinas/:marina_id/berths/bulk', authenticateOrApiKey, cat.bulkBerths);
router.post('/marinas/:marina_id/images/upload', authenticateOrApiKey, rawImage, cat.uploadImage);
for (const kind of Object.keys(cat.TABLES)) {
  const h = cat.childHandlers(kind);
  router.get(`/marinas/:marina_id/${kind}`, authenticateOrApiKey, h.list);
  router.post(`/marinas/:marina_id/${kind}`, authenticateOrApiKey, h.create);
  router.put(`/marinas/:marina_id/${kind}/:id`, authenticateOrApiKey, h.update);
}

// Guest rail -- the only prefix a site's forwarder passes through.
const G = '/guest/:marina';
router.get(G, authenticateOrApiKey, guest.resolveMarina, guest.getMarinaMap);
router.get(`${G}/availability`, authenticateOrApiKey, guest.resolveMarina, guest.getAvailability);
router.get(`${G}/doc-requirements`, authenticateOrApiKey, guest.resolveMarina, guest.getDocRequirements);
router.post(`${G}/quote`, authenticateOrApiKey, guest.resolveMarina, guest.quote);

// Unauthenticated: the emailed confirm link (spa pattern).
router.get('/confirm-booking/:id/:confirmToken', guest.confirmBookingLink);

// Bearer only: passport data never reaches the key rail (guest sites hold the key).
router.get('/bookings/:id/documents', authenticate, docCtrl.listBookingDocuments);
router.get('/documents/:id/file', authenticate, docCtrl.streamDocumentFile);
router.put('/documents/:id', authenticate, docCtrl.updateDocument);

router.get('/bookings', authenticateOrApiKey, bookings.listBookings);
router.post('/bookings', authenticateOrApiKey, bookings.createBooking);
router.get('/bookings/:id', authenticateOrApiKey, bookings.getBooking);
router.put('/bookings/:id', authenticateOrApiKey, bookings.updateBooking);

router.post(`${G}/bookings`, authenticateOrApiKey, bookingLimiter, guest.resolveMarina, guest.createGuestBooking);
router.get(`${G}/bookings/:id`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.getGuestBooking);
router.post(`${G}/bookings/:id/cancel`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.cancelGuestBooking);
router.get(`${G}/bookings/:id/ably-token`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.ablyToken);
router.post(`${G}/bookings/:id/confirm-payment`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.confirmPayment);
router.post(`${G}/bookings/:id/documents`, authenticateOrApiKey, uploadLimiter, guest.resolveMarina, guest.requireBookingToken, rawDocSafe, docCtrl.uploadDocument);

router.get(`${G}/contract-preview`, authenticateOrApiKey, guest.resolveMarina, guest.contractPreview);
router.post(`${G}/bookings/:id/contract`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.agreeContract);
router.post(`${G}/enquiries`, authenticateOrApiKey, enquiryLimiter, guest.resolveMarina, guest.createEnquiry);

module.exports = router;
