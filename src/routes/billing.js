const router = require('express').Router();
const ctrl = require('../controllers/billing');
const { authenticate, requireRole } = require('../middleware/auth');

// The Stripe webhook is mounted directly in app.js (it needs the raw body,
// before express.json()).
router.get('/', authenticate, ctrl.getBilling);
router.put('/', authenticate, requireRole('admin'), ctrl.updateBilling);
router.get('/ledger', authenticate, ctrl.listLedger);
router.post('/checkout', authenticate, requireRole('admin'), ctrl.createCheckout);
router.post('/checkout/confirm', authenticate, requireRole('admin'), ctrl.confirmCheckout);

module.exports = router;
