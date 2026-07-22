const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listGuests);
router.get('/lookup', authenticate, ctrl.lookupGuest);
router.get('/:id', authenticate, ctrl.getGuest);
router.get('/:id/summary', authenticate, ctrl.getGuestSummary);
router.post('/', authenticateOrApiKey, ctrl.createGuest);
router.put('/:id', authenticate, ctrl.updateGuest);
router.delete('/:id', authenticate, ctrl.deleteGuest);

module.exports = router;
