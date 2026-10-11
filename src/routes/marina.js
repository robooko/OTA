const router = require('express').Router();
const ctrl = require('../controllers/marina');
const cat = require('../controllers/marinaCatalogue');
const guest = require('../controllers/marinaGuest');
const bookings = require('../controllers/marinaBookings');
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

router.get('/bookings', authenticateOrApiKey, bookings.listBookings);
router.post('/bookings', authenticateOrApiKey, bookings.createBooking);
router.get('/bookings/:id', authenticateOrApiKey, bookings.getBooking);
router.put('/bookings/:id', authenticateOrApiKey, bookings.updateBooking);

router.post(`${G}/bookings`, authenticateOrApiKey, guest.resolveMarina, guest.createGuestBooking);
router.get(`${G}/bookings/:id`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.getGuestBooking);
router.post(`${G}/bookings/:id/cancel`, authenticateOrApiKey, guest.resolveMarina, guest.requireBookingToken, guest.cancelGuestBooking);

module.exports = router;
