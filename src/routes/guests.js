const router = require('express').Router();
const ctrl = require('../controllers/guests');

router.get('/', ctrl.listGuests);
router.get('/:id', ctrl.getGuest);
router.post('/', ctrl.createGuest);
router.put('/:id', ctrl.updateGuest);
router.delete('/:id', ctrl.deleteGuest);

module.exports = router;
