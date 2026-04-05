const router = require('express').Router();
const ctrl = require('../controllers/golf');

// Courses
router.get('/courses', ctrl.listCourses);
router.post('/courses', ctrl.createCourse);
router.put('/courses/:id', ctrl.updateCourse);

// Tee times
router.post('/tee-times/bulk', ctrl.bulkCreateTeeTimes);
router.get('/tee-times/search', ctrl.searchTeeTimes);

// Bookings
router.get('/bookings', ctrl.listBookings);
router.post('/bookings', ctrl.createBooking);
router.put('/bookings/:id', ctrl.updateBooking);

module.exports = router;
