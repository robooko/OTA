const router = require('express').Router();
const ctrl = require('../controllers/payments');
const { authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Manual payment records: staff, or a FULL api key (MCP, scripts).
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/booking/:booking_id', staffOrFullKey, ctrl.listPayments);
router.post('/', staffOrFullKey, ctrl.createPayment);
router.put('/:id', staffOrFullKey, ctrl.updatePayment);

module.exports = router;
