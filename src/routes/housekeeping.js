const router = require('express').Router();
const ctrl = require('../controllers/housekeeping');
const { authenticateOrApiKey, requirePermission } = require('../middleware/auth');

// Room housekeeping. Cleaning is open to any staff login; inspection and
// setup take the named permissions (docs/superpowers/specs/2026-10-31-permissions-design.md).
const manage = requirePermission('housekeeping.manage');

router.get('/board', authenticateOrApiKey, ctrl.board);

router.get('/settings', authenticateOrApiKey, ctrl.getSettings);
router.put('/settings', authenticateOrApiKey, manage, ctrl.putSettings);

router.put('/overrides', authenticateOrApiKey, ctrl.putOverride);
router.delete('/overrides/:room_id/:date', authenticateOrApiKey, ctrl.deleteOverride);

router.put('/rooms/:room_id/status', authenticateOrApiKey, ctrl.putRoomStatus);

router.post('/jobs/:id/claim', authenticateOrApiKey, ctrl.claimJob);
router.delete('/jobs/:id/claim', authenticateOrApiKey, ctrl.unclaimJob);
router.post('/jobs/:id/start', authenticateOrApiKey, ctrl.startJob);
router.post('/jobs/:id/finish', authenticateOrApiKey, ctrl.finishJob);

module.exports = router;
