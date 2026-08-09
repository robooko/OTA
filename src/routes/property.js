const router = require('express').Router();
const ctrl = require('../controllers/property');
const { authenticate, requireRole } = require('../middleware/auth');

router.get('/api-key', authenticate, requireRole('admin'), ctrl.getApiKey);
router.post('/api-key/rotate', authenticate, requireRole('admin'), ctrl.rotateApiKey);

module.exports = router;
