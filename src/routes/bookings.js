const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/', requireApiKey, ctrl.listBookings);
router.get('/:id', requireApiKey, ctrl.getBooking);
router.post('/', requireApiKey, ctrl.createBooking);
router.put('/:id', requireApiKey, ctrl.updateBooking);
router.delete('/:id', requireApiKey, ctrl.cancelBooking);

module.exports = router;
