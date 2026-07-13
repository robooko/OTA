const router = require('express').Router();
const ctrl = require('../controllers/payments');
const { authenticate } = require('../middleware/auth');

router.get('/booking/:booking_id', authenticate, ctrl.listPayments);
router.post('/', authenticate, ctrl.createPayment);
router.put('/:id', authenticate, ctrl.updatePayment);

module.exports = router;
