const router = require('express').Router();
const ctrl = require('../controllers/roomService');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Menu items
router.get('/menu', authenticate, ctrl.listItems);
router.post('/menu', authenticate, ctrl.createItem);
router.put('/menu/:id', authenticate, ctrl.updateItem);

// Orders
router.get('/orders', authenticate, ctrl.listOrders);
router.get('/orders/:id', authenticate, ctrl.getOrder);
router.post('/orders', authenticateOrApiKey, ctrl.createOrder);
router.put('/orders/:id/status', authenticate, ctrl.updateOrderStatus);

module.exports = router;
