const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listBookings);
router.get('/:id', authenticateOrApiKey, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticateOrApiKey, ctrl.cancelBooking);

module.exports = router;
