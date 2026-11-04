const router = require('express').Router();
const ctrl = require('../controllers/channels');
const { authenticateOrApiKey, requireRoleOrApiKey } = require('../middleware/auth');

// Staff, or a FULL api key (MCP, scripts); a scoped key gets 403.
const staffOrFullKey = [authenticateOrApiKey, requireRoleOrApiKey('admin', 'staff')];

router.get('/', staffOrFullKey, ctrl.listChannels);
router.post('/', staffOrFullKey, ctrl.createChannel);
router.get('/:id', staffOrFullKey, ctrl.getChannel);
router.put('/:id', staffOrFullKey, ctrl.updateChannel);
router.delete('/:id', staffOrFullKey, ctrl.deleteChannel);
router.put('/:id/mappings', staffOrFullKey, ctrl.replaceMappings);
router.get('/:id/trims', staffOrFullKey, ctrl.listTrims);
router.post('/:id/trims', staffOrFullKey, ctrl.createTrim);
router.delete('/:id/trims/:trim_id', staffOrFullKey, ctrl.deleteTrim);
router.post('/:id/sync', staffOrFullKey, ctrl.syncNow);
router.get('/:id/drift', staffOrFullKey, ctrl.getDrift);
router.get('/:id/inbound', staffOrFullKey, ctrl.listInbound);
router.post('/:id/test-reservations', staffOrFullKey, ctrl.testReservation);

module.exports = router;
