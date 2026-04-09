const router = require('express').Router();
const ctrl = require('../controllers/golf');
const { requireApiKey } = require('../middleware/apiKey');

// Courses
router.get('/courses', ctrl.listCourses);
router.post('/courses', requireApiKey, ctrl.createCourse);
router.put('/courses/:id', requireApiKey, ctrl.updateCourse);

// Tee times
router.post('/tee-times/bulk', requireApiKey, ctrl.bulkCreateTeeTimes);
router.get('/tee-times/search', ctrl.searchTeeTimes);

// Bookings
router.get('/bookings', requireApiKey, ctrl.listBookings);
router.post('/bookings', requireApiKey, ctrl.createBooking);
router.put('/bookings/:id', requireApiKey, ctrl.updateBooking);

module.exports = router;
