const router = require('express').Router();
const ctrl = require('../controllers/availability');

router.get('/search', ctrl.searchAvailability);
router.get('/types', ctrl.getRoomTypeAvailability);
router.get('/rooms/:room_id', ctrl.getRoomAvailability);
router.put('/rooms/:room_id', ctrl.upsertRoomAvailability);
router.post('/refresh', ctrl.refreshView);

module.exports = router;
