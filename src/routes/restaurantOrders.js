const router = require('express').Router();
const ctrl = require('../controllers/restaurantOrders');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Menu items
router.get('/menu', authenticateOrApiKey, ctrl.listMenuItems);
router.post('/menu', authenticateOrApiKey, ctrl.createMenuItem);
router.put('/menu/bulk-delete', authenticateOrApiKey, ctrl.bulkDeleteMenuItems);
router.put('/menu/rename-category', authenticateOrApiKey, ctrl.renameMenuCategory);
router.put('/menu/:id', authenticateOrApiKey, ctrl.updateMenuItem);

// Orders
router.get('/ably-token', authenticate, ctrl.getAblyToken);
router.get('/', authenticateOrApiKey, ctrl.listOrders);
router.get('/:id/ably-token', authenticateOrApiKey, ctrl.getOrderAblyToken);
router.get('/:id', authenticate, ctrl.getOrder);
router.post('/', authenticateOrApiKey, ctrl.createOrder);
router.put('/:id', authenticateOrApiKey, ctrl.updateOrder);
router.put('/:id/status', authenticateOrApiKey, ctrl.updateOrderStatus);
// Pickup orders only (see restaurantOrders.js) -- an at-table order pays
// through /api/restaurant-table-sessions/:id/payment-intent instead.
router.post('/:id/payment-intent', authenticateOrApiKey, ctrl.createOrderPaymentIntent);
router.post('/:id/confirm-payment', authenticateOrApiKey, ctrl.confirmOrderPayment);

module.exports = router;
