const router = require('express').Router();
const ctrl = require('../controllers/beachClub');
const { authenticateOrApiKey } = require('../middleware/auth');

// Staff or the property's API key, like tours -- every query is scoped to
// the resolved property.

// Beds
router.get('/beds', authenticateOrApiKey, ctrl.listBeds);
router.post('/beds', authenticateOrApiKey, ctrl.createBed);
router.put('/beds/:id', authenticateOrApiKey, ctrl.updateBed);

// Search
router.get('/beds/search', authenticateOrApiKey, ctrl.searchBeds);

// Bookings
router.get('/bookings', authenticateOrApiKey, ctrl.listBookings);
router.post('/bookings', authenticateOrApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticateOrApiKey, ctrl.updateBooking);

module.exports = router;
