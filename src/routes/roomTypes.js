const router = require('express').Router();
const ctrl = require('../controllers/roomTypes');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', ctrl.listRoomTypes);
router.get('/:id', ctrl.getRoomType);
router.post('/', authenticate, requireRole('admin'), ctrl.createRoomType);
router.put('/:id', authenticate, requireRole('admin'), ctrl.updateRoomType);

module.exports = router;
