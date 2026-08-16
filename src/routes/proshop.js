const router = require('express').Router();
const ctrl = require('../controllers/proshop');
const { authenticate } = require('../middleware/auth');

// Shops
router.get('/shops', authenticate, ctrl.listShops);
router.post('/shops', authenticate, ctrl.createShop);
router.put('/shops/:id', authenticate, ctrl.updateShop);

// Catalogue
router.get('/items', authenticate, ctrl.listItems);
router.post('/items', authenticate, ctrl.createItem);
router.put('/items/:id', authenticate, ctrl.updateItem);

// Booking items
router.get('/booking/:booking_id', authenticate, ctrl.listBookingItems);
router.post('/booking/:booking_id', authenticate, ctrl.addBookingItem);
router.delete('/booking/:booking_id/:id', authenticate, ctrl.removeBookingItem);

module.exports = router;
