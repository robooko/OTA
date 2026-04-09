const router = require('express').Router();
const ctrl = require('../controllers/equipment');
const { requireApiKey } = require('../middleware/apiKey');

// Equipment
router.get('/', ctrl.listEquipment);
router.post('/', requireApiKey, ctrl.createEquipment);
router.put('/:id', requireApiKey, ctrl.updateEquipment);

// Search
router.get('/search', ctrl.searchEquipment);

// Hires
router.get('/hires', requireApiKey, ctrl.listHires);
router.post('/hires', requireApiKey, ctrl.createHire);
router.put('/hires/:id', requireApiKey, ctrl.updateHire);

module.exports = router;
