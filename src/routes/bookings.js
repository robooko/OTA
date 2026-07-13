const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', authenticate, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticate, ctrl.cancelBooking);

module.exports = router;
