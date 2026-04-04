const router = require('express').Router();
const ctrl = require('../controllers/rooms');

router.get('/', ctrl.listRooms);
router.get('/:id', ctrl.getRoom);
router.post('/', ctrl.createRoom);
router.put('/:id', ctrl.updateRoom);

module.exports = router;
