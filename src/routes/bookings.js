const router = require('express').Router();
const ctrl = require('../controllers/bookings');

router.get('/', ctrl.listBookings);
router.get('/:id', ctrl.getBooking);
router.post('/', ctrl.createBooking);
router.put('/:id', ctrl.updateBooking);
router.delete('/:id', ctrl.cancelBooking);

module.exports = router;
