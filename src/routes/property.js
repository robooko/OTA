const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, authenticateOrApiKey, requireRole } = require('../middleware/auth');

router.get('/me', authenticate, ctrl.getCurrentProperty);
router.put('/me', authenticate, requireRole('admin'), ctrl.updateCurrentProperty);

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);
router.post('/api-key/disable', authenticate, requireRole('admin'), ctrl.disableApiKey);
router.post('/api-key/enable', authenticate, requireRole('admin'), ctrl.enableApiKey);

router.get('/vercel/projects', authenticate, ctrl.listVercelProjects);
router.get('/vercel/projects/:projectId/analytics', authenticateOrApiKey, ctrl.getVercelProjectAnalytics);
router.get('/vercel/connect', authenticate, ctrl.getVercelConnectUrl);
router.get('/vercel/callback', ctrl.vercelConnectCallback);
router.get('/vercel/status', authenticate, ctrl.getVercelConnectionStatus);
router.post('/vercel/disconnect', authenticate, ctrl.disconnectVercel);

router.get('/websites', authenticateOrApiKey, ctrl.listWebsites);
router.post('/websites', authenticate, ctrl.createWebsite);
router.put('/websites/:id', authenticate, ctrl.updateWebsite);
router.get('/websites/:id/analytics', authenticateOrApiKey, ctrl.getWebsiteAnalytics);

module.exports = router;
