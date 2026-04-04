const router = require('express').Router();
const ctrl = require('../controllers/restaurant');

// Tables
router.get('/tables', ctrl.listTables);
router.post('/tables', ctrl.createTable);
router.put('/tables/:id', ctrl.updateTable);

// Time slots
router.get('/slots', ctrl.listSlots);
router.post('/slots', ctrl.createSlot);
router.get('/slots/search', ctrl.searchSlots);

// Reservations
router.get('/reservations', ctrl.listReservations);
router.get('/reservations/:id', ctrl.getReservation);
router.post('/reservations', ctrl.createReservation);
router.put('/reservations/:id', ctrl.updateReservation);

module.exports = router;
