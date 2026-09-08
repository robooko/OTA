const router = require('express').Router();
const ctrl = require('../controllers/proshop');
const { authenticateOrApiKey } = require('../middleware/auth');

// Shops
router.get('/shops', authenticateOrApiKey, ctrl.listShops);
router.post('/shops', authenticateOrApiKey, ctrl.createShop);
router.put('/shops/:id', authenticateOrApiKey, ctrl.updateShop);

// Catalogue
router.get('/items', authenticateOrApiKey, ctrl.listItems);
router.post('/items', authenticateOrApiKey, ctrl.createItem);
router.put('/items/:id', authenticateOrApiKey, ctrl.updateItem);

// Booking items
router.get('/booking/:booking_id', authenticateOrApiKey, ctrl.listBookingItems);
router.post('/booking/:booking_id', authenticateOrApiKey, ctrl.addBookingItem);
router.delete('/booking/:booking_id/:id', authenticateOrApiKey, ctrl.removeBookingItem);

// Orders (guest self-checkout from the venue's website, no booking)
router.get('/orders', authenticateOrApiKey, ctrl.listOrders);
router.post('/orders/lookup', authenticateOrApiKey, ctrl.lookupOrder); // before /orders/:id
router.get('/orders/:id', authenticateOrApiKey, ctrl.getOrder);
router.post('/orders', authenticateOrApiKey, ctrl.createOrder);
router.put('/orders/:id', authenticateOrApiKey, ctrl.updateOrder);
router.post('/orders/:id/payment-intent', authenticateOrApiKey, ctrl.createOrderPaymentIntent);
router.post('/orders/:id/confirm-payment', authenticateOrApiKey, ctrl.confirmOrderPayment);

// Returns (guest via website, or staff via dashboard) -- managed as enquiries
router.get('/returns', authenticateOrApiKey, ctrl.listReturns);
router.get('/returns/:id', authenticateOrApiKey, ctrl.getReturn);
router.put('/returns/:id', authenticateOrApiKey, ctrl.updateReturnStatus);

module.exports = router;
