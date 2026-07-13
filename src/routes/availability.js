const router = require('express').Router();
const ctrl = require('../controllers/availability');
const { authenticate } = require('../middleware/auth');

router.get('/search', ctrl.searchAvailability);
router.get('/types', authenticate, ctrl.getRoomTypeAvailability);
router.get('/overrides', authenticate, ctrl.listOverrides);
router.delete('/overrides/:id', authenticate, ctrl.deleteOverride);
router.get('/rooms/:room_id', authenticate, ctrl.getRoomAvailability);
router.put('/rooms/:room_id', authenticate, ctrl.upsertRoomAvailability);
router.post('/refresh', authenticate, ctrl.refreshView);

module.exports = router;
