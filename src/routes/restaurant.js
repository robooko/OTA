const router = require('express').Router();
const ctrl = require('../controllers/restaurant');

// Restaurants
router.get('/', ctrl.listRestaurants);
router.get('/:id', ctrl.getRestaurant);
router.post('/', ctrl.createRestaurant);
router.put('/:id', ctrl.updateRestaurant);

// Tables (scoped to restaurant)
router.get('/:restaurant_id/tables', ctrl.listTables);
router.post('/:restaurant_id/tables', ctrl.createTable);
router.put('/:restaurant_id/tables/:id', ctrl.updateTable);

// Time slots (scoped to restaurant)
router.get('/:restaurant_id/slots', ctrl.listSlots);
router.post('/:restaurant_id/slots', ctrl.createSlot);
router.get('/:restaurant_id/slots/search', ctrl.searchSlots);

// Reservations (scoped to restaurant)
router.get('/:restaurant_id/reservations', ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', ctrl.getReservation);
router.post('/:restaurant_id/reservations', ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', ctrl.updateReservation);

module.exports = router;
