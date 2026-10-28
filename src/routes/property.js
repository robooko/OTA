const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, authenticateOrApiKey, requireRole, requireRoleOrApiKey } = require('../middleware/auth');

// Both on the API-key rail: identity is read-only content, and
// currency/timezone are the same "safe config" category as ai-replies'
// instructions-only PUT (updateCurrentProperty touches only those two
// fields -- nothing that changes what runs unsupervised, unlike ai-replies'
// mode/auto_send_min_score, which is why those stay bearer+admin). Lets the
// MCP get_property/update_property tools work over a plain X-Api-Key
// connection, which is how most MCP clients here actually authenticate.
router.get('/me', authenticateOrApiKey, ctrl.getCurrentProperty);
router.put('/me', authenticateOrApiKey, ctrl.updateCurrentProperty);

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
router.put('/stripe/publishable-key', authenticate, requireRole('admin'), ctrl.setStripePublishableKey);
router.post('/stripe/publishable-key/clear', authenticate, requireRole('admin'), ctrl.clearStripePublishableKey);

// GET and the instructions-only PUT are on the API-key rail too, so the MCP
// tools (get_ai_reply_settings / set_ai_reply_instructions) can guide a
// venue's setup; mode and auto_send_min_score stay bearer+admin.
router.get('/ai-replies', authenticateOrApiKey, ctrl.getAiReplySettings);
router.put('/ai-replies', authenticate, requireRole('admin'), ctrl.updateAiReplySettings);
router.put('/ai-replies/instructions', authenticateOrApiKey, ctrl.updateAiReplyInstructions);

// Phone receptionist. All of it is on the API-key rail so an agent (MCP
// voice tools) can set a venue up end to end: find and buy a number, switch
// it on, set the transfer number. Calls are BUXS-charged, so on/off can't
// overspend. Staff sessions still need admin.
router.get('/voice', authenticateOrApiKey, ctrl.getVoiceSettings);
router.put('/voice', authenticate, requireRole('admin'), ctrl.updateVoiceSettings);
router.put('/voice/enabled', authenticateOrApiKey, requireRoleOrApiKey('admin'), ctrl.updateVoiceEnabled);
router.put('/voice/transfer-number', authenticateOrApiKey, requireRoleOrApiKey('admin'), ctrl.updateVoiceTransferNumber);
router.get('/voice/available-numbers', authenticateOrApiKey, requireRoleOrApiKey('admin'), ctrl.searchVoiceNumbers);
router.post('/voice/number', authenticateOrApiKey, requireRoleOrApiKey('admin'), ctrl.provisionVoiceNumber);
router.delete('/voice/number', authenticateOrApiKey, requireRoleOrApiKey('admin'), ctrl.releaseVoiceNumber);

// On the API-key rail for the same reason as /me above -- logo, colour and
// cancel link are the venue's own presentation settings, not something that
// changes what runs unsupervised -- so the MCP get/update_email_branding
// tools work over a plain X-Api-Key. A staff session still needs the admin
// role it always did; requireRoleOrApiKey only waives it for the key.
router.get('/email-branding', authenticateOrApiKey, ctrl.getEmailBranding);
router.put('/email-branding', authenticateOrApiKey, requireRoleOrApiKey('admin'), ctrl.updateEmailBranding);

// GET is on the API-key rail (read-only pointers). PUT is staff + admin
// only: whoever sets these chooses the copy, images and links ChatGPT shows
// under the venue's Stripe name -- same reasoning as ai-replies' mode.
router.get('/agentic-commerce', authenticateOrApiKey, ctrl.getAgenticCommerce);
router.put('/agentic-commerce', authenticate, requireRole('admin'), ctrl.updateAgenticCommerce);

router.get('/reminders', authenticate, ctrl.getReminderSettings);
router.put('/reminders', authenticate, requireRole('admin'), ctrl.updateReminderSettings);

// Writes on the API-key rail too (MCP create/update_website): a website row
// is just a URL plus which analytics source the dashboard chart reads.
router.get('/websites', authenticateOrApiKey, ctrl.listWebsites);
router.post('/websites', authenticateOrApiKey, ctrl.createWebsite);
router.put('/websites/:id', authenticateOrApiKey, ctrl.updateWebsite);
router.get('/websites/:id/analytics', authenticateOrApiKey, ctrl.getWebsiteAnalytics);
// Tells Settings which service-account address a venue grants Viewer access
// to in GA4. No secret in the response -- the email is meant to be shared.
router.get('/analytics/google', authenticateOrApiKey, ctrl.getGoogleAnalyticsSetup);

module.exports = router;
