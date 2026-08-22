const router = require('express').Router();
const ctrl = require('../controllers/tours');
const { authenticateOrApiKey } = require('../middleware/auth');

// Tours
router.get('/', authenticateOrApiKey, ctrl.listTours);
router.post('/', authenticateOrApiKey, ctrl.createTour);
router.put('/:id', authenticateOrApiKey, ctrl.updateTour);

// Slots
router.post('/slots/bulk', authenticateOrApiKey, ctrl.bulkCreateSlots);
router.get('/slots/search', authenticateOrApiKey, ctrl.searchSlots);
router.put('/slots/:id', authenticateOrApiKey, ctrl.updateSlot);

// Bookings
router.get('/bookings', authenticateOrApiKey, ctrl.listBookings);
router.post('/bookings', authenticateOrApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticateOrApiKey, ctrl.updateBooking);

module.exports = router;
