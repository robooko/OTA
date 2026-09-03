const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Unauthenticated: a link in the reminder email/text itself, not a
// dashboard action -- the reservation id is the capability.
router.get('/reminder-opt-out/:reservation_id/:channel', ctrl.reminderOptOut);

// Restaurants
router.get('/', authenticateOrApiKey, ctrl.listRestaurants);
router.post('/', authenticateOrApiKey, ctrl.createRestaurant);

// Reservations across all of the property's restaurants -- must be registered
// before GET /:id, otherwise Express matches "reservations" as the :id param.
router.get('/reservations', authenticateOrApiKey, ctrl.listAllReservations);

router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant);
router.put('/:id', authenticateOrApiKey, ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', authenticateOrApiKey, ctrl.listTables);
router.post('/:restaurant_id/tables', authenticateOrApiKey, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticateOrApiKey, ctrl.updateTable);

// Service Periods
router.get('/:restaurant_id/service-periods', authenticateOrApiKey, ctrl.listServicePeriods);
router.put('/:restaurant_id/service-periods', authenticateOrApiKey, ctrl.setServicePeriods);

// Availability
router.get('/:restaurant_id/availability/search', ctrl.searchAvailability);

// Reservations
router.get('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.getReservation);
router.get('/:restaurant_id/reservations/:id/payment-intent', authenticateOrApiKey, ctrl.getReservationPaymentIntent);
router.post('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.updateReservation);
router.post('/:restaurant_id/reservations/:id/seat', authenticateOrApiKey, ctrl.seatReservation);
router.post('/:restaurant_id/reservations/:id/cancel', authenticateOrApiKey, ctrl.cancelReservation);

module.exports = router;
