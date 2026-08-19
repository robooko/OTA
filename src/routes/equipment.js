const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Equipment
router.get('/', authenticate, ctrl.listEquipment);
router.post('/', authenticateOrApiKey, ctrl.createEquipment);
router.put('/:id', authenticateOrApiKey, ctrl.updateEquipment);

// Search
router.get('/search', authenticate, ctrl.searchEquipment);

// Hires
router.get('/hires', authenticate, ctrl.listHires);
router.post('/hires', authenticateOrApiKey, ctrl.createHire);
router.put('/hires/:id', authenticateOrApiKey, ctrl.updateHire);

module.exports = router;
