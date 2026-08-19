const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

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
router.post('/:restaurant_id/reservations', authenticateOrApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticateOrApiKey, ctrl.updateReservation);

module.exports = router;
