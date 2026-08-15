const router = require('express').Router();
const ctrl = require('../controllers/restaurantOrders');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Menu items
router.get('/menu', authenticateOrApiKey, ctrl.listMenuItems);
router.post('/menu', authenticate, ctrl.createMenuItem);
router.put('/menu/:id', authenticate, ctrl.updateMenuItem);

// Orders
router.get('/', authenticate, ctrl.listOrders);
router.get('/:id', authenticate, ctrl.getOrder);
router.post('/', authenticateOrApiKey, ctrl.createOrder);
router.put('/:id/status', authenticate, ctrl.updateOrderStatus);

module.exports = router;
