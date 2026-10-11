const router = require('express').Router();
const ctrl = require('../controllers/organization');
const { authenticateOrg, requireRole } = require('../middleware/auth');

// Staff routes spanning the org's hotels -- no X-Property-Id needed.
router.get('/properties', authenticateOrg, ctrl.listProperties);
router.post('/properties', authenticateOrg, requireRole('admin'), ctrl.createProperty);

router.get('/api-key', authenticateOrg, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticateOrg, requireRole('admin'), ctrl.rotateApiKey);
router.post('/api-key/disable', authenticateOrg, requireRole('admin'), ctrl.disableApiKey);
router.post('/api-key/enable', authenticateOrg, requireRole('admin'), ctrl.enableApiKey);

module.exports = router;
