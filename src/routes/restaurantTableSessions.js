const router = require('express').Router();
const ctrl = require('../controllers/restaurantTableSessions');
const { authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.getOpenSession);
router.post('/connection-token', authenticateOrApiKey, ctrl.createConnectionToken);
router.get('/:id', authenticateOrApiKey, ctrl.getSession);
router.get('/:id/ably-token', authenticateOrApiKey, ctrl.getSessionAblyToken);
router.post('/:id/payment-intent', authenticateOrApiKey, ctrl.createSessionPaymentIntent);
router.put('/:id/close', authenticateOrApiKey, ctrl.closeSession);

module.exports = router;
