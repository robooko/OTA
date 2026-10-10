const router = require('express').Router();
const ctrl = require('../controllers/marina');
const { authenticate, authenticateOrApiKey, requireRole } = require('../middleware/auth');

// Key routes match /property/stripe/key: bearer + admin, never readable back.
router.put('/key', authenticate, requireRole('admin'), ctrl.setSidonMarinaKey);
router.post('/key/clear', authenticate, requireRole('admin'), ctrl.clearSidonMarinaKey);
router.get('/bookings', authenticateOrApiKey, ctrl.listMarinaBookings);

module.exports = router;
