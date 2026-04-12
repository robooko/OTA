const router = require('express').Router();
const ctrl = require('../controllers/roomService');
const { requireApiKey } = require('../middleware/apiKey');

// Menu items
router.get('/menu', ctrl.listItems);
router.post('/menu', requireApiKey, ctrl.createItem);
router.put('/menu/:id', requireApiKey, ctrl.updateItem);

// Orders
router.get('/orders', requireApiKey, ctrl.listOrders);
router.get('/orders/:id', requireApiKey, ctrl.getOrder);
router.post('/orders', requireApiKey, ctrl.createOrder);
router.put('/orders/:id/status', requireApiKey, ctrl.updateOrderStatus);

module.exports = router;
