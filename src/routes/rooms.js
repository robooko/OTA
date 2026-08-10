const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listRooms);
router.get('/:id', authenticate, ctrl.getRoom);
router.post('/', authenticateOrApiKey, ctrl.createRoom);
router.put('/:id', authenticateOrApiKey, ctrl.updateRoom);

module.exports = router;
