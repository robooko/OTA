const router = require('express').Router();
const ctrl = require('../controllers/payments');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/booking/:booking_id', authenticate, ctrl.listPayments);
router.post('/', authenticate, requireRole('admin', 'staff'), ctrl.createPayment);
router.put('/:id', authenticate, requireRole('admin', 'staff'), ctrl.updatePayment);

module.exports = router;
