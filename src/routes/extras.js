const router = require('express').Router();
const ctrl = require('../controllers/extras');
const { authenticate } = require('../middleware/auth');

// Extras catalogue
router.get('/', authenticate, ctrl.listExtras);
router.post('/', authenticate, ctrl.createExtra);
router.put('/:id', authenticate, ctrl.updateExtra);

// Booking extras
router.get('/booking/:booking_id', authenticate, ctrl.listBookingExtras);
router.post('/booking/:booking_id', authenticate, ctrl.addBookingExtra);
router.delete('/booking/:booking_id/:id', authenticate, ctrl.removeBookingExtra);

module.exports = router;
