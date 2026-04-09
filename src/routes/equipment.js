const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

// Equipment
router.get('/', ctrl.listEquipment);
router.post('/', authenticate, requireRole('admin'), ctrl.createEquipment);
router.put('/:id', authenticate, requireRole('admin'), ctrl.updateEquipment);

// Search
router.get('/search', ctrl.searchEquipment);

// Hires
router.get('/hires', authenticate, requireRole('admin', 'staff'), ctrl.listHires);
router.post('/hires', requireApiKey, ctrl.createHire);
router.put('/hires/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateHire);

module.exports = router;
