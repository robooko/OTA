const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { requireApiKey } = require('../middleware/apiKey');

// Treatments
router.get('/treatments', ctrl.listTreatments);
router.post('/treatments', requireApiKey, ctrl.createTreatment);
router.put('/treatments/:id', requireApiKey, ctrl.updateTreatment);

// Therapists
router.get('/therapists', ctrl.listTherapists);
router.post('/therapists', requireApiKey, ctrl.createTherapist);

// Slots
router.get('/slots', requireApiKey, ctrl.listSlots);
router.post('/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Appointments
router.get('/appointments', requireApiKey, ctrl.listAppointments);
router.post('/appointments', requireApiKey, ctrl.createAppointment);
router.put('/appointments/:id', requireApiKey, ctrl.updateAppointment);

module.exports = router;
