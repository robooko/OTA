const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Spas
router.get('/', authenticate, ctrl.listSpas);
router.get('/:id', authenticate, ctrl.getSpa);
router.post('/', authenticateOrApiKey, ctrl.createSpa);
router.put('/:id', authenticateOrApiKey, ctrl.updateSpa);

// Treatments
router.get('/:spa_id/treatments', authenticate, ctrl.listTreatments);
router.post('/:spa_id/treatments', authenticateOrApiKey, ctrl.createTreatment);
router.put('/:spa_id/treatments/:id', authenticateOrApiKey, ctrl.updateTreatment);

// Therapists
router.get('/:spa_id/therapists', authenticate, ctrl.listTherapists);
router.post('/:spa_id/therapists', authenticateOrApiKey, ctrl.createTherapist);
router.put('/:spa_id/therapists/:id', authenticateOrApiKey, ctrl.updateTherapist);

// Slots
router.get('/:spa_id/slots', authenticate, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', authenticateOrApiKey, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', authenticate, ctrl.searchSlots);
router.put('/:spa_id/slots/:id', authenticateOrApiKey, ctrl.updateSlot);

// Appointments
router.get('/:spa_id/appointments', authenticate, ctrl.listAppointments);
router.get('/:spa_id/appointments/:id', authenticate, ctrl.getAppointment);
router.post('/:spa_id/appointments', authenticateOrApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', authenticateOrApiKey, ctrl.updateAppointment);

module.exports = router;
