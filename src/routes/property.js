const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/me', authenticate, ctrl.getCurrentProperty);
router.put('/me', authenticate, requireRole('admin'), ctrl.updateCurrentProperty);

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);
router.post('/api-key/disable', authenticate, requireRole('admin'), ctrl.disableApiKey);
router.post('/api-key/enable', authenticate, requireRole('admin'), ctrl.enableApiKey);

module.exports = router;
