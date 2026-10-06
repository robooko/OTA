const router = require('express').Router();
const ctrl = require('../controllers/reviews');
const { authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listRequests);
router.get('/opt-outs', authenticateOrApiKey, ctrl.listOptOuts);

module.exports = router;
