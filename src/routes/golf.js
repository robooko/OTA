const router = require('express').Router();
const ctrl = require('../controllers/golf');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

// Courses
router.get('/courses', authenticate, ctrl.listCourses);
router.post('/courses', authenticateOrApiKey, ctrl.createCourse);
router.put('/courses/:id', authenticateOrApiKey, ctrl.updateCourse);

// Tee times
router.post('/tee-times/bulk', authenticateOrApiKey, ctrl.bulkCreateTeeTimes);
router.get('/tee-times/search', authenticate, ctrl.searchTeeTimes);

// Bookings
router.get('/bookings', authenticate, ctrl.listBookings);
router.post('/bookings', authenticateOrApiKey, ctrl.createBooking);
router.put('/bookings/:id', authenticateOrApiKey, ctrl.updateBooking);

module.exports = router;
