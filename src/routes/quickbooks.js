const router = require('express').Router();
const ctrl = require('../controllers/quickbooks');
const { authenticateOrg, requireRole } = require('../middleware/auth');

// Org-level: one QuickBooks company per organization. The callback is hit
// by Intuit directly (no Clerk session) -- the org rides in signed `state`.
router.get('/connect', authenticateOrg, requireRole('admin'), ctrl.getConnectUrl);
router.get('/callback', ctrl.connectCallback);
router.get('/status', authenticateOrg, ctrl.getStatus);
router.post('/disconnect', authenticateOrg, requireRole('admin'), ctrl.disconnect);
router.get('/profit-and-loss', authenticateOrg, requireRole('admin'), ctrl.getProfitAndLoss);

module.exports = router;
