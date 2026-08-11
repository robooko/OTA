const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Restaurants
router.get('/', authenticateOrApiKey, ctrl.listRestaurants);
router.get('/:id', authenticateOrApiKey, ctrl.getRestaurant);
router.post('/', authenticate, ctrl.createRestaurant);
router.put('/:id', authenticate, ctrl.updateRestaurant);

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
