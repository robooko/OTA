const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const ratePlans = require('../controllers/ratePlans');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listRoomTypes);
router.get('/:id/rates', authenticateOrApiKey, ctrl.listRoomTypeRates);
router.put('/:id/rates', authenticateOrApiKey, ctrl.upsertRoomTypeRates);
router.get('/:id/rate-plans', authenticateOrApiKey, ratePlans.listRatePlans);
router.post('/:id/rate-plans', authenticate, ratePlans.createRatePlan);
router.put('/:id/rate-plans/:plan_id', authenticate, ratePlans.updateRatePlan);
router.get('/:id', authenticate, ctrl.getRoomType);
router.post('/', authenticateOrApiKey, ctrl.createRoomType);
router.put('/:id', authenticateOrApiKey, ctrl.updateRoomType);

module.exports = router;
