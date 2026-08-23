const router = require('express').Router();
const ctrl = require('../controllers/restaurantTableSessions');
const { authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.getOpenSession);
router.put('/:id/close', authenticateOrApiKey, ctrl.closeSession);

module.exports = router;
