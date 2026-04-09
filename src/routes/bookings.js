const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/', (req, res, next) => {
  // guest_id scoped query — API key only, no JWT needed
  if (req.query.guest_id) return requireApiKey(req, res, next);
  // full list — JWT + staff/admin
  return authenticate(req, res, () => requireRole('admin', 'staff')(req, res, next));
}, ctrl.listBookings);
router.get('/:id', authenticate, ctrl.getBooking);
router.post('/', requireApiKey, ctrl.createBooking);
router.put('/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateBooking);
router.delete('/:id', authenticate, requireRole('admin', 'staff'), ctrl.cancelBooking);

module.exports = router;
