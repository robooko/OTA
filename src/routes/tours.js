const router = require('express').Router();
const ctrl = require('../controllers/tours');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

// Tours
router.get('/', ctrl.listTours);
router.post('/', authenticate, requireRole('admin'), ctrl.createTour);
router.put('/:id', authenticate, requireRole('admin'), ctrl.updateTour);

// Slots
router.post('/slots/bulk', authenticate, requireRole('admin', 'staff'), ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Bookings
router.get('/bookings', authenticate, requireRole('admin', 'staff'), ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateBooking);

module.exports = router;
