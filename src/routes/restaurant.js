const router = require('express').Router();
const ctrl = require('../controllers/restaurant');
const { authenticate, requireRole } = require('../middleware/auth');
const { requireApiKey } = require('../middleware/apiKey');

// Restaurants
router.get('/', ctrl.listRestaurants);
router.get('/:id', ctrl.getRestaurant);
router.post('/', authenticate, requireRole('admin'), ctrl.createRestaurant);
router.put('/:id', authenticate, requireRole('admin'), ctrl.updateRestaurant);

// Tables
router.get('/:restaurant_id/tables', ctrl.listTables);
router.post('/:restaurant_id/tables', authenticate, requireRole('admin'), ctrl.createTable);
router.put('/:restaurant_id/tables/:id', authenticate, requireRole('admin'), ctrl.updateTable);

// Slots
router.get('/:restaurant_id/slots', ctrl.listSlots);
router.post('/:restaurant_id/slots', authenticate, requireRole('admin', 'staff'), ctrl.createSlot);
router.post('/:restaurant_id/slots/bulk', authenticate, requireRole('admin', 'staff'), ctrl.bulkCreateSlots);
router.get('/:restaurant_id/slots/search', ctrl.searchSlots);

// Reservations
router.get('/:restaurant_id/reservations', authenticate, requireRole('admin', 'staff'), ctrl.listReservations);
router.get('/:restaurant_id/reservations/:id', authenticate, ctrl.getReservation);
router.post('/:restaurant_id/reservations', requireApiKey, ctrl.createReservation);
router.put('/:restaurant_id/reservations/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateReservation);

module.exports = router;
