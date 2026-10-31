const router = require('express').Router();
const ctrl = require('../controllers/availability');
const { authenticate, authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Staff, or a FULL api key (MCP, scripts); a scoped key gets 403.
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/search', ctrl.searchAvailability);
router.get('/types', authenticateOrApiKey, ctrl.getRoomTypeAvailability);
router.get('/overrides', staffOrFullKey, ctrl.listOverrides);
router.delete('/overrides/:id', staffOrFullKey, ctrl.deleteOverride);
router.get('/rooms/:room_id', authenticateOrApiKey, ctrl.getRoomAvailability);
router.put('/rooms/:room_id', authenticateOrApiKey, ctrl.upsertRoomAvailability);
router.post('/refresh', staffOrFullKey, ctrl.refreshView);

module.exports = router;
