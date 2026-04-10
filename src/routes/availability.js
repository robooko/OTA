const router = require('express').Router();
const ctrl = require('../controllers/availability');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/search', ctrl.searchAvailability);
router.get('/types', ctrl.getRoomTypeAvailability);
router.get('/overrides', requireApiKey, ctrl.listOverrides);
router.delete('/overrides/:id', requireApiKey, ctrl.deleteOverride);
router.get('/rooms/:room_id', ctrl.getRoomAvailability);
router.put('/rooms/:room_id', requireApiKey, ctrl.upsertRoomAvailability);
router.post('/refresh', requireApiKey, ctrl.refreshView);

module.exports = router;
