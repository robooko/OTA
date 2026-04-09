const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listGuests);
router.get('/:id', authenticate, ctrl.getGuest);
router.post('/', authenticate, requireRole('admin', 'staff'), ctrl.createGuest);
router.put('/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateGuest);
router.delete('/:id', authenticate, requireRole('admin'), ctrl.deleteGuest);

module.exports = router;
