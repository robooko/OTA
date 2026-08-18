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

module.exports = router;
