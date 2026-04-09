const router = require('express').Router();
const ctrl = require('../controllers/rooms');
const { requireApiKey } = require('../middleware/apiKey');

router.get('/', ctrl.listRooms);
router.get('/:id', ctrl.getRoom);
router.post('/', requireApiKey, ctrl.createRoom);
router.put('/:id', requireApiKey, ctrl.updateRoom);

module.exports = router;
