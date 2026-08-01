const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { requireApiKey } = require('../middleware/apiKey');

// Spas
router.get('/', ctrl.listSpas);
router.get('/:id', ctrl.getSpa);
router.post('/', requireApiKey, ctrl.createSpa);
router.put('/:id', requireApiKey, ctrl.updateSpa);

// Treatments
router.get('/:spa_id/treatments', ctrl.listTreatments);
router.post('/:spa_id/treatments', requireApiKey, ctrl.createTreatment);
router.put('/:spa_id/treatments/:id', requireApiKey, ctrl.updateTreatment);

// Therapists
router.get('/:spa_id/therapists', ctrl.listTherapists);
router.post('/:spa_id/therapists', requireApiKey, ctrl.createTherapist);
router.put('/:spa_id/therapists/:id', requireApiKey, ctrl.updateTherapist);

// Slots
router.get('/:spa_id/slots', requireApiKey, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', ctrl.searchSlots);

// Appointments
router.get('/:spa_id/appointments', requireApiKey, ctrl.listAppointments);
router.post('/:spa_id/appointments', requireApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', requireApiKey, ctrl.updateAppointment);

module.exports = router;
