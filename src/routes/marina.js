const router = require('express').Router();
const ctrl = require('../controllers/marina');
const cat = require('../controllers/marinaCatalogue');
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

module.exports = router;
