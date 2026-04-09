const router = require('express').Router();
const ctrl = require('../controllers/beachClub');
const { requireApiKey } = require('../middleware/apiKey');

// Beds
router.get('/beds', ctrl.listBeds);
router.post('/beds', requireApiKey, ctrl.createBed);
router.put('/beds/:id', requireApiKey, ctrl.updateBed);

// Search
router.get('/beds/search', ctrl.searchBeds);

// Bookings
router.get('/bookings', requireApiKey, ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', requireApiKey, ctrl.updateBooking);

module.exports = router;
