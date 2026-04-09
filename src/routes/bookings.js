const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', authenticate, requireRole('admin', 'staff'), ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', authenticate, ctrl.createBooking);
router.put('/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateBooking);
router.delete('/:id', authenticate, requireRole('admin', 'staff'), ctrl.cancelBooking);

module.exports = router;
