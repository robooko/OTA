const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, ctrl.listRooms);
router.get('/:id', authenticate, ctrl.getRoom);
router.post('/', authenticate, ctrl.createRoom);
router.put('/:id', authenticate, ctrl.updateRoom);

module.exports = router;
