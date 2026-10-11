const router = require('express').Router();
const ctrl = require('../controllers/organization');
const { authenticateOrgKey } = require('../middleware/auth');

// The org's website build (org API key only).
router.get('/properties', authenticateOrgKey, ctrl.listSiteProperties);

module.exports = router;
