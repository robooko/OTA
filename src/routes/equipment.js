const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { authenticateOrApiKey } = require('../middleware/auth');

// Equipment
router.get('/', authenticateOrApiKey, ctrl.listEquipment);
router.post('/', authenticateOrApiKey, ctrl.createEquipment);
router.put('/:id', authenticateOrApiKey, ctrl.updateEquipment);

// Search
router.get('/search', authenticateOrApiKey, ctrl.searchEquipment);

// Hires
router.get('/hires', authenticateOrApiKey, ctrl.listHires);
router.post('/hires', authenticateOrApiKey, ctrl.createHire);
router.put('/hires/:id', authenticateOrApiKey, ctrl.updateHire);

module.exports = router;
