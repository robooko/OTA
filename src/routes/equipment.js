const router = require('express').Router();
const ctrl = require('../controllers/equipment');

// Equipment
router.get('/', ctrl.listEquipment);
router.post('/', ctrl.createEquipment);
router.put('/:id', ctrl.updateEquipment);

// Search availability
router.get('/search', ctrl.searchEquipment);

// Hire bookings
router.get('/hires', ctrl.listHires);
router.post('/hires', ctrl.createHire);
router.put('/hires/:id', ctrl.updateHire);

module.exports = router;
