const router = require('express').Router();
const ctrl = require('../controllers/tours');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Tours
router.get('/', authenticate, ctrl.listTours);
router.post('/', authenticate, ctrl.createTour);
router.put('/:id', authenticate, ctrl.updateTour);

// Slots
router.post('/slots/bulk', authenticate, ctrl.bulkCreateSlots);
router.get('/slots/search', authenticate, ctrl.searchSlots);

// Bookings
router.get('/bookings', authenticate, ctrl.listBookings);
router.post('/bookings', authenticateOrApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticate, ctrl.updateBooking);

module.exports = router;
