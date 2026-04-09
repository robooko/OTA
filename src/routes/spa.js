const router = require('express').Router();
const ctrl = require('../controllers/spa');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

// Treatments
router.get('/treatments', ctrl.listTreatments);
router.post('/treatments', authenticate, requireRole('admin'), ctrl.createTreatment);
router.put('/treatments/:id', authenticate, requireRole('admin'), ctrl.updateTreatment);

// Therapists
router.get('/therapists', ctrl.listTherapists);
router.post('/therapists', authenticate, requireRole('admin'), ctrl.createTherapist);

// Slots
router.get('/slots', authenticate, requireRole('admin', 'staff'), ctrl.listSlots);
router.post('/slots/bulk', authenticate, requireRole('admin', 'staff'), ctrl.bulkCreateSlots);
router.get('/slots/search', ctrl.searchSlots);

// Appointments
router.get('/appointments', authenticate, requireRole('admin', 'staff'), ctrl.listAppointments);
router.post('/appointments', requireApiKey, ctrl.createAppointment);
router.put('/appointments/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateAppointment);

module.exports = router;
