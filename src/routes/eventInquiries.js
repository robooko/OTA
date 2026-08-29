const router = require('express').Router();
const ctrl = require('../controllers/eventInquiries');
const { authenticateOrApiKey } = require('../middleware/auth');

// Collection-level AI draft queue. Declared before any '/:id' route so a
// future GET /:id can't swallow the literal 'ai-drafts' segment.
router.get('/ai-drafts', authenticateOrApiKey, ctrl.listAiDrafts);

router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticateOrApiKey, ctrl.updateInquiry);

router.get('/:id/replies', authenticateOrApiKey, ctrl.listReplies);
router.post('/:id/replies', authenticateOrApiKey, ctrl.createReply);

router.get('/:id/ai-drafts', authenticateOrApiKey, ctrl.listInquiryAiDrafts);
router.post('/:id/ai-drafts', authenticateOrApiKey, ctrl.generateAiDraft);
router.post('/:id/ai-drafts/:draftId/approve', authenticateOrApiKey, ctrl.approveAiDraft);
router.post('/:id/ai-drafts/:draftId/reject', authenticateOrApiKey, ctrl.rejectAiDraft);

module.exports = router;
