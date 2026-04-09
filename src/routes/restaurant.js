const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { requireApiKey } = require('../middleware/apiKey');

// Restaurants
router.get('/', ctrl.listRestaurants);
router.get('/:id', ctrl.getRestaurant);
router.post('/', requireApiKey, ctrl.createRestaurant);
router.put('/:id', requireApiKey, ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', ctrl.listTables);
router.post('/:restaurant_id/tables', requireApiKey, ctrl.createTable);
router.put('/:restaurant_id/tables/:id', requireApiKey, ctrl.updateTable);

// Slots
router.get('/:restaurant_id/slots', ctrl.listSlots);
router.post('/:restaurant_id/slots', requireApiKey, ctrl.createSlot);
router.post('/:restaurant_id/slots/bulk', requireApiKey, ctrl.bulkCreateSlots);
router.get('/:restaurant_id/slots/search', ctrl.searchSlots);

// Reservations
router.get('/:restaurant_id/reservations', requireApiKey, ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', requireApiKey, ctrl.getReservation);
router.post('/:restaurant_id/reservations', requireApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', requireApiKey, ctrl.updateReservation);

module.exports = router;
