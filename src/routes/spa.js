const router = require('express').Router();
const ctrl = require('../controllers/spa');
const payments = require('../controllers/spaPayments');
const { authenticateOrApiKey } = require('../middleware/auth');

// Spas
router.get('/', authenticateOrApiKey, ctrl.listSpas);
// Property-wide, across every spa -- must come before /:id or Express would
// match "appointments" as a spa id.
router.get('/appointments', authenticateOrApiKey, ctrl.listAppointmentsForProperty);
router.get('/:id', authenticateOrApiKey, ctrl.getSpa);
router.post('/', authenticateOrApiKey, ctrl.createSpa);
router.put('/:id', authenticateOrApiKey, ctrl.updateSpa);

// Treatments
router.get('/:spa_id/treatments', authenticateOrApiKey, ctrl.listTreatments);
router.post('/:spa_id/treatments', authenticateOrApiKey, ctrl.createTreatment);
router.put('/:spa_id/treatments/:id', authenticateOrApiKey, ctrl.updateTreatment);

// Therapists
router.get('/:spa_id/therapists', authenticateOrApiKey, ctrl.listTherapists);
router.post('/:spa_id/therapists', authenticateOrApiKey, ctrl.createTherapist);
router.put('/:spa_id/therapists/:id', authenticateOrApiKey, ctrl.updateTherapist);

// Therapist hours & time off
router.get('/:spa_id/therapists/:id/hours', authenticateOrApiKey, ctrl.listTherapistHours);
router.put('/:spa_id/therapists/:id/hours', authenticateOrApiKey, ctrl.setTherapistHours);
router.get('/:spa_id/therapists/:id/time-off', authenticateOrApiKey, ctrl.listTherapistTimeOff);
router.post('/:spa_id/therapists/:id/time-off', authenticateOrApiKey, ctrl.createTherapistTimeOff);
router.delete('/:spa_id/therapists/:id/time-off/:offId', authenticateOrApiKey, ctrl.deleteTherapistTimeOff);

// Computed availability
router.get('/:spa_id/availability', authenticateOrApiKey, ctrl.searchSpaAvailability);

// Realtime (subscribe-only token for the appointments channel)
router.get('/:spa_id/ably-token', authenticateOrApiKey, ctrl.getSpaAblyToken);

// Slots
router.get('/:spa_id/slots', authenticateOrApiKey, ctrl.listSlots);
router.post('/:spa_id/slots/bulk', authenticateOrApiKey, ctrl.bulkCreateSlots);
router.get('/:spa_id/slots/search', authenticateOrApiKey, ctrl.searchSlots);
router.put('/:spa_id/slots/:id', authenticateOrApiKey, ctrl.updateSlot);

// Appointments
router.get('/:spa_id/appointments', authenticateOrApiKey, ctrl.listAppointments);
router.get('/:spa_id/appointments/:id', authenticateOrApiKey, ctrl.getAppointment);
router.post('/:spa_id/appointments', authenticateOrApiKey, ctrl.createAppointment);
router.put('/:spa_id/appointments/:id', authenticateOrApiKey, ctrl.updateAppointment);

// Tap to Pay (see 2026-08-30-spa-tap-to-pay-backend-requirements.md)
router.post('/:spa_id/appointments/:id/payment-intent', authenticateOrApiKey, payments.createAppointmentPaymentIntent);
router.post('/:spa_id/appointments/:id/confirm-payment', authenticateOrApiKey, payments.confirmAppointmentPayment);

module.exports = router;
