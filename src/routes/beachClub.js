const router = require('express').Router();
const ctrl = require('../controllers/beachClub');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

// Beds
router.get('/beds', ctrl.listBeds);
router.post('/beds', authenticate, requireRole('admin'), ctrl.createBed);
router.put('/beds/:id', authenticate, requireRole('admin'), ctrl.updateBed);

// Search
router.get('/beds/search', ctrl.searchBeds);

// Bookings
router.get('/bookings', authenticate, requireRole('admin', 'staff'), ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateBooking);

module.exports = router;
