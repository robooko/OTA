const router = require('express').Router();
const ctrl = require('../controllers/beachClub');

// Beds
router.get('/beds', ctrl.listBeds);
router.post('/beds', ctrl.createBed);
router.put('/beds/:id', ctrl.updateBed);

// Search available beds
router.get('/beds/search', ctrl.searchBeds);

// Bookings
router.get('/bookings', ctrl.listBookings);
router.post('/bookings', ctrl.createBooking);
router.put('/bookings/:id', ctrl.updateBooking);

module.exports = router;
