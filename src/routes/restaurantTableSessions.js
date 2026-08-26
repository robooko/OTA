const router = require('express').Router();
const ctrl = require('../controllers/restaurantTableSessions');
const { authenticateOrApiKey, authenticate } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.getOpenSession);
router.post('/', authenticateOrApiKey, ctrl.openSession);
router.post('/connection-token', authenticateOrApiKey, ctrl.createConnectionToken);
router.get('/:id', authenticateOrApiKey, ctrl.getSession);
router.get('/:id/ably-token', authenticateOrApiKey, ctrl.getSessionAblyToken);
router.post('/:id/payment-intent', authenticateOrApiKey, ctrl.createSessionPaymentIntent);
router.put('/:id/close', authenticateOrApiKey, ctrl.closeSession);
// Bearer-only: rotating (or first-issuing) a join code is a staff action.
router.put('/:id/join-code', authenticate, ctrl.rotateJoinCode);

module.exports = router;
