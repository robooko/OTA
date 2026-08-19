const router = require('express').Router();
const ctrl = require('../controllers/availability');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/search', ctrl.searchAvailability);
router.get('/types', authenticateOrApiKey, ctrl.getRoomTypeAvailability);
router.get('/overrides', authenticate, ctrl.listOverrides);
router.delete('/overrides/:id', authenticate, ctrl.deleteOverride);
router.get('/rooms/:room_id', authenticateOrApiKey, ctrl.getRoomAvailability);
router.put('/rooms/:room_id', authenticateOrApiKey, ctrl.upsertRoomAvailability);
router.post('/refresh', authenticate, ctrl.refreshView);

module.exports = router;
