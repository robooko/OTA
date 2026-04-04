const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');

router.get('/', ctrl.listRoomTypes);
router.get('/:id', ctrl.getRoomType);
router.post('/', ctrl.createRoomType);
router.put('/:id', ctrl.updateRoomType);

module.exports = router;
