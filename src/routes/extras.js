const router = require('express').Router();
const ctrl = require('../controllers/extras');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

// Extras catalogue
router.get('/', requireApiKey, ctrl.listExtras);
router.post('/', authenticate, requireRole('admin', 'staff'), ctrl.createExtra);
router.put('/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateExtra);

// Booking extras (nested under bookings)
router.get('/booking/:booking_id', requireApiKey, ctrl.listBookingExtras);
router.post('/booking/:booking_id', requireApiKey, ctrl.addBookingExtra);
router.delete('/booking/:booking_id/:id', authenticate, requireRole('admin', 'staff'), ctrl.removeBookingExtra);

module.exports = router;
