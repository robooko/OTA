const router = require('express').Router();
const ctrl = require('../controllers/extras');
const { requireApiKey } = require('../middleware/apiKey');

// Extras catalogue
router.get('/', requireApiKey, ctrl.listExtras);
router.post('/', requireApiKey, ctrl.createExtra);
router.put('/:id', requireApiKey, ctrl.updateExtra);

// Booking extras
router.get('/booking/:booking_id', requireApiKey, ctrl.listBookingExtras);
router.post('/booking/:booking_id', requireApiKey, ctrl.addBookingExtra);
router.delete('/booking/:booking_id/:id', requireApiKey, ctrl.removeBookingExtra);

module.exports = router;
