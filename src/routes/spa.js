const router = require('express').Router();
const ctrl = require('../controllers/spa');

// Treatments
router.get('/treatments', ctrl.listTreatments);
router.post('/treatments', ctrl.createTreatment);
router.put('/treatments/:id', ctrl.updateTreatment);

// Therapists
router.get('/therapists', ctrl.listTherapists);
router.post('/therapists', ctrl.createTherapist);

// Slots
router.get('/slots', ctrl.listSlots);
router.post('/slots/bulk', ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Appointments
router.get('/appointments', ctrl.listAppointments);
router.post('/appointments', ctrl.createAppointment);
router.put('/appointments/:id', ctrl.updateAppointment);

module.exports = router;
