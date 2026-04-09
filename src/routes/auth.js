const router = require('express').Router();
const ctrl = require('../controllers/auth');
const { authenticate, requireRole } = require('../middleware/auth');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.get('/me', authenticate, ctrl.me);
router.get('/users', authenticate, requireRole('admin'), ctrl.listUsers);
router.put('/users/:id', authenticate, requireRole('admin'), ctrl.updateUser);

module.exports = router;
