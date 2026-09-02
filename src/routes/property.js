const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, authenticateOrApiKey, requireRole } = require('../middleware/auth');

// Read-only identity (id, name, currency, timezone) is on the API-key rail
// too, so the MCP get_property tool can confirm which venue it operates for.
router.get('/me', authenticateOrApiKey, ctrl.getCurrentProperty);
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
router.put('/vercel/pat', authenticate, requireRole('admin'), ctrl.setVercelPat);
router.post('/vercel/pat/clear', authenticate, requireRole('admin'), ctrl.clearVercelPat);

router.get('/stripe/status', authenticate, ctrl.getStripeStatus);
router.put('/stripe/key', authenticate, requireRole('admin'), ctrl.setStripeKey);
router.post('/stripe/key/clear', authenticate, requireRole('admin'), ctrl.clearStripeKey);

// GET and the instructions-only PUT are on the API-key rail too, so the MCP
// tools (get_ai_reply_settings / set_ai_reply_instructions) can guide a
// venue's setup; mode and auto_send_min_score stay bearer+admin.
router.get('/ai-replies', authenticateOrApiKey, ctrl.getAiReplySettings);
router.put('/ai-replies', authenticate, requireRole('admin'), ctrl.updateAiReplySettings);
router.put('/ai-replies/instructions', authenticateOrApiKey, ctrl.updateAiReplyInstructions);

router.get('/email-branding', authenticate, ctrl.getEmailBranding);
router.put('/email-branding', authenticate, requireRole('admin'), ctrl.updateEmailBranding);

router.get('/websites', authenticateOrApiKey, ctrl.listWebsites);
router.post('/websites', authenticate, ctrl.createWebsite);
router.put('/websites/:id', authenticate, ctrl.updateWebsite);
router.get('/websites/:id/analytics', authenticateOrApiKey, ctrl.getWebsiteAnalytics);

module.exports = router;
