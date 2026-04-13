const router = require('express').Router();
const ctrl = require('../controllers/proshop');
const { requireApiKey } = require('../middleware/apiKey');

// Catalogue
router.get('/items', ctrl.listItems);
router.post('/items', requireApiKey, ctrl.createItem);
router.put('/items/:id', requireApiKey, ctrl.updateItem);

// Booking items
router.get('/booking/:booking_id', requireApiKey, ctrl.listBookingItems);
router.post('/booking/:booking_id', requireApiKey, ctrl.addBookingItem);
router.delete('/booking/:booking_id/:id', requireApiKey, ctrl.removeBookingItem);

module.exports = router;
