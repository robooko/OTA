const router = require('express').Router();
const ctrl = require('../controllers/availability');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/search', ctrl.searchAvailability);
router.get('/types', ctrl.getRoomTypeAvailability);
router.get('/overrides', authenticate, requireRole('admin', 'staff'), ctrl.listOverrides);
router.get('/rooms/:room_id', ctrl.getRoomAvailability);
router.put('/rooms/:room_id', authenticate, requireRole('admin', 'staff'), ctrl.upsertRoomAvailability);
router.post('/refresh', authenticate, requireRole('admin'), ctrl.refreshView);

module.exports = router;
