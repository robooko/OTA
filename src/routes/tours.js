const router = require('express').Router();
const ctrl = require('../controllers/tours');
const { requireApiKey } = require('../middleware/apiKey');

// Tours
router.get('/', ctrl.listTours);
router.post('/', requireApiKey, ctrl.createTour);
router.put('/:id', requireApiKey, ctrl.updateTour);

// Slots
router.post('/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Bookings
router.get('/bookings', requireApiKey, ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', requireApiKey, ctrl.updateBooking);

module.exports = router;
