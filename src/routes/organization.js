const router = require('express').Router();
const ctrl = require('../controllers/organization');
const apiKeys = require('../controllers/apiKeys').organization;
const { authenticateOrg, requireRole } = require('../middleware/auth');

// Staff routes spanning the org's hotels -- no X-Property-Id needed.
router.get('/properties', authenticateOrg, ctrl.listProperties);
router.post('/properties', authenticateOrg, requireRole('admin'), ctrl.createProperty);

// The org's main ('Default') website key, old shapes kept for the dashboard.
router.get('/api-key', authenticateOrg, requireRole('admin'), apiKeys.getLegacy);
router.post('/api-key/rotate', authenticateOrg, requireRole('admin'), apiKeys.rotateLegacy);
router.post('/api-key/disable', authenticateOrg, requireRole('admin'), apiKeys.disableLegacy);
router.post('/api-key/enable', authenticateOrg, requireRole('admin'), apiKeys.enableLegacy);
// Every org key: named, individually enabled, full (permissions null) or scoped.
router.get('/api-keys', authenticateOrg, requireRole('admin'), apiKeys.list);
router.post('/api-keys', authenticateOrg, requireRole('admin'), apiKeys.create);
router.put('/api-keys/:id', authenticateOrg, requireRole('admin'), apiKeys.update);
router.delete('/api-keys/:id', authenticateOrg, requireRole('admin'), apiKeys.remove);

module.exports = router;
