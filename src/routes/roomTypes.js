const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/', ctrl.listRoomTypes);
router.get('/:id', ctrl.getRoomType);
router.post('/', requireApiKey, ctrl.createRoomType);
router.put('/:id', requireApiKey, ctrl.updateRoomType);

module.exports = router;
