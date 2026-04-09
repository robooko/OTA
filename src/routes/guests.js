const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/', requireApiKey, ctrl.listGuests);
router.get('/lookup', requireApiKey, ctrl.lookupGuest);
router.get('/:id', requireApiKey, ctrl.getGuest);
router.post('/', requireApiKey, ctrl.createGuest);
router.put('/:id', requireApiKey, ctrl.updateGuest);
router.delete('/:id', requireApiKey, ctrl.deleteGuest);

module.exports = router;
