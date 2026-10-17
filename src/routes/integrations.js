const router = require('express').Router();
const ctrl = require('../controllers/integrations');
const { authenticateOrg, requireRole } = require('../middleware/auth');

// Org-level, one connection per org per provider. The callback is hit by
// the provider directly (no Clerk session) -- the org rides in signed `state`.
router.use('/:provider', ctrl.requireProvider);
router.get('/:provider/connect', authenticateOrg, requireRole('admin'), ctrl.getConnectUrl);
router.get('/:provider/callback', ctrl.connectCallback);
router.get('/:provider/status', authenticateOrg, ctrl.getStatus);
router.post('/:provider/disconnect', authenticateOrg, requireRole('admin'), ctrl.disconnect);

module.exports = router;
