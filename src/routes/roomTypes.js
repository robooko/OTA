const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const ratePlans = require('../controllers/ratePlans');
const { authenticate, authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Staff, or a FULL api key (MCP, scripts); a scoped key gets 403.
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/', authenticateOrApiKey, ctrl.listRoomTypes);
router.get('/:id/rates', authenticateOrApiKey, ctrl.listRoomTypeRates);
router.put('/:id/rates', authenticateOrApiKey, ctrl.upsertRoomTypeRates);
router.get('/:id/rate-plans', authenticateOrApiKey, ratePlans.listRatePlans);
router.post('/:id/rate-plans', staffOrFullKey, ratePlans.createRatePlan);
router.put('/:id/rate-plans/:plan_id', staffOrFullKey, ratePlans.updateRatePlan);
router.get('/:id', authenticateOrApiKey, ctrl.getRoomType);
router.post('/', authenticateOrApiKey, ctrl.createRoomType);
router.put('/:id', authenticateOrApiKey, ctrl.updateRoomType);

module.exports = router;
