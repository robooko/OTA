const router = require('express').Router();
const ctrl = require('../controllers/eventInquiries');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listInquiries);
router.post('/', authenticateOrApiKey, ctrl.createInquiry);
router.put('/:id', authenticate, ctrl.updateInquiry);

module.exports = router;
