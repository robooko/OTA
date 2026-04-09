const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/', authenticate, ctrl.listGuests);
router.get('/:id', authenticate, ctrl.getGuest);
router.post('/', requireApiKey, ctrl.createGuest);
router.put('/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateGuest);
router.delete('/:id', authenticate, requireRole('admin'), ctrl.deleteGuest);

module.exports = router;
