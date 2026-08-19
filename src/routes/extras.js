const router = require('express').Router();
const ctrl = require('../controllers/extras');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Extras catalogue
router.get('/', authenticateOrApiKey, ctrl.listExtras);
router.post('/', authenticateOrApiKey, ctrl.createExtra);
router.put('/:id', authenticateOrApiKey, ctrl.updateExtra);

// Booking extras
router.get('/booking/:booking_id', authenticate, ctrl.listBookingExtras);
router.post('/booking/:booking_id', authenticateOrApiKey, ctrl.addBookingExtra);
router.delete('/booking/:booking_id/:id', authenticateOrApiKey, ctrl.removeBookingExtra);

module.exports = router;
