// Room overbooking -- see docs/superpowers/specs/2026-11-05-room-overbooking-design.md.
// Changing the switch, cap or allowances needs overbooking.manage (admins,
// full api keys, granted staff / scoped keys); reading is staff or a full key.
const router = require('express').Router();
const ctrl = require('../controllers/overbooking');
const { authenticateOrApiKey, requirePermission, requireRoleOrApiKey } = require('../middleware/auth');

const manage = [authenticateOrApiKey, requirePermission('overbooking.manage')];
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/', staffOrFullKey, ctrl.getOverview);
router.get('/arrivals', staffOrFullKey, ctrl.getArrivals);
router.get('/pace', staffOrFullKey, ctrl.getPace);
router.get('/settings', staffOrFullKey, ctrl.getSettings);
router.put('/settings', manage, ctrl.putSettings);
router.post('/allowances', manage, ctrl.postAllowances);
router.put('/allowances/:room_type_id/:date', manage, ctrl.putManual);

module.exports = router;
