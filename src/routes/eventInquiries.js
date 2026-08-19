const router = require('express').Router();
const ctrl = require('../controllers/eventInquiries');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticateOrApiKey, ctrl.updateInquiry);

router.get('/:id/replies', authenticate, ctrl.listReplies);
router.post('/:id/replies', authenticateOrApiKey, ctrl.createReply);

module.exports = router;
