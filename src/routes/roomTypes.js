const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listRoomTypes);
router.get('/:id', authenticate, ctrl.getRoomType);
router.post('/', authenticate, ctrl.createRoomType);
router.put('/:id', authenticate, ctrl.updateRoomType);

module.exports = router;
