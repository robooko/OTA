const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { authenticate } = require('../middleware/auth');

// Equipment
router.get('/', authenticate, ctrl.listEquipment);
router.post('/', authenticate, ctrl.createEquipment);
router.put('/:id', authenticate, ctrl.updateEquipment);

// Search
router.get('/search', authenticate, ctrl.searchEquipment);

// Hires
router.get('/hires', authenticate, ctrl.listHires);
router.post('/hires', authenticate, ctrl.createHire);
router.put('/hires/:id', authenticate, ctrl.updateHire);

module.exports = router;
