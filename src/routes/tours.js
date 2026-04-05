const router = require('express').Router();
const ctrl = require('../controllers/tours');

// Tours
router.get('/', ctrl.listTours);
router.post('/', ctrl.createTour);
router.put('/:id', ctrl.updateTour);

// Slots
router.post('/slots/bulk', ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Bookings
router.get('/bookings', ctrl.listBookings);
router.post('/bookings', ctrl.createBooking);
router.put('/bookings/:id', ctrl.updateBooking);

module.exports = router;
