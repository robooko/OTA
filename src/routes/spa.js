const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Spas
router.get('/', authenticate, ctrl.listSpas);
router.get('/:id', authenticate, ctrl.getSpa);
router.post('/', authenticate, ctrl.createSpa);
router.put('/:id', authenticate, ctrl.updateSpa);

// Treatments
router.get('/:spa_id/treatments', authenticate, ctrl.listTreatments);
router.post('/:spa_id/treatments', authenticate, ctrl.createTreatment);
router.put('/:spa_id/treatments/:id', authenticate, ctrl.updateTreatment);

// Therapists
router.get('/:spa_id/therapists', authenticate, ctrl.listTherapists);
router.post('/:spa_id/therapists', authenticate, ctrl.createTherapist);
router.put('/:spa_id/therapists/:id', authenticate, ctrl.updateTherapist);

// Slots
router.get('/:spa_id/slots', authenticate, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', authenticate, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', authenticate, ctrl.searchSlots);
router.put('/:spa_id/slots/:id', authenticate, ctrl.updateSlot);

// Appointments
router.get('/:spa_id/appointments', authenticate, ctrl.listAppointments);
router.get('/:spa_id/appointments/:id', authenticate, ctrl.getAppointment);
router.post('/:spa_id/appointments', authenticateOrApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', authenticate, ctrl.updateAppointment);

module.exports = router;
