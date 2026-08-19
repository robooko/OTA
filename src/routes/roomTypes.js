const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listRoomTypes);
router.get('/:id/rates', authenticateOrApiKey, ctrl.listRoomTypeRates);
router.put('/:id/rates', authenticateOrApiKey, ctrl.upsertRoomTypeRates);
router.get('/:id', authenticate, ctrl.getRoomType);
router.post('/', authenticateOrApiKey, ctrl.createRoomType);
router.put('/:id', authenticateOrApiKey, ctrl.updateRoomType);

module.exports = router;
