const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/', ctrl.listRooms);
router.get('/:id', ctrl.getRoom);
router.post('/', authenticate, requireRole('admin'), ctrl.createRoom);
router.put('/:id', authenticate, requireRole('admin'), ctrl.updateRoom);

module.exports = router;
