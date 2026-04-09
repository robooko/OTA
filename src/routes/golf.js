const router = require('express').Router();
const ctrl = require('../controllers/golf');
const { authenticate, requireRole } = require('../middleware/auth');

// Courses
router.get('/courses', ctrl.listCourses);
router.post('/courses', authenticate, requireRole('admin'), ctrl.createCourse);
router.put('/courses/:id', authenticate, requireRole('admin'), ctrl.updateCourse);

// Tee times
router.post('/tee-times/bulk', authenticate, requireRole('admin', 'staff'), ctrl.bulkCreateTeeTimes);
router.get('/tee-times/search', ctrl.searchTeeTimes);

// Bookings
router.get('/bookings', authenticate, requireRole('admin', 'staff'), ctrl.listBookings);
router.post('/bookings', ctrl.createBooking);
router.put('/bookings/:id', authenticate, requireRole('admin', 'staff'), ctrl.updateBooking);

module.exports = router;
