const router = require('express').Router();
const ctrl = require('../controllers/restaurantWebOrders');
const { authenticateOrApiKey } = require('../middleware/auth');

// "Nando's style" food ordering: order and pay on the website, no running
// tab. See migrate-2026-09-06-restaurant-web-orders.sql.
router.get('/', authenticateOrApiKey, ctrl.listOrders);
router.get('/:id', authenticateOrApiKey, ctrl.getOrder);
router.post('/', authenticateOrApiKey, ctrl.createOrder);
router.put('/:id', authenticateOrApiKey, ctrl.updateOrder);
router.post('/:id/payment-intent', authenticateOrApiKey, ctrl.createOrderPaymentIntent);
router.post('/:id/confirm-payment', authenticateOrApiKey, ctrl.confirmOrderPayment);

module.exports = router;
