const router = require('express').Router();
const ctrl = require('../controllers/payments');

router.get('/booking/:booking_id', ctrl.listPayments);
router.post('/', ctrl.createPayment);
router.put('/:id', ctrl.updatePayment);

module.exports = router;
