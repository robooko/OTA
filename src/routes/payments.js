const router = require('express').Router();
const ctrl = require('../controllers/payments');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/booking/:booking_id', requireApiKey, ctrl.listPayments);
router.post('/', requireApiKey, ctrl.createPayment);
router.put('/:id', requireApiKey, ctrl.updatePayment);

module.exports = router;
