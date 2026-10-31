const router = require('express').Router();
const ctrl = require('../controllers/guests');
const { authenticate, authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Guest records are staff data: staff, or a FULL api key (MCP, scripts). A
// scoped key (a booking website's) gets lookup and create only. Delete stays
// staff-only -- it is irreversible.
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/', staffOrFullKey, ctrl.listGuests);
router.get('/lookup', authenticateOrApiKey, ctrl.lookupGuest);
router.get('/:id', staffOrFullKey, ctrl.getGuest);
router.get('/:id/summary', staffOrFullKey, ctrl.getGuestSummary);
router.post('/', authenticateOrApiKey, ctrl.createGuest);
router.put('/:id', staffOrFullKey, ctrl.updateGuest);
router.delete('/:id', authenticate, ctrl.deleteGuest);

module.exports = router;
