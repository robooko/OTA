const router = require('express').Router();
const ctrl = require('../controllers/courses');
const { authenticateOrApiKey } = require('../middleware/auth');

// Courses
router.get('/', authenticateOrApiKey, ctrl.listCourses);
router.post('/', authenticateOrApiKey, ctrl.createCourse);
router.put('/:id', authenticateOrApiKey, ctrl.updateCourse);
router.delete('/:id', authenticateOrApiKey, ctrl.deleteCourse);

// Runs
router.post('/:id/runs', authenticateOrApiKey, ctrl.createRuns);
router.put('/runs/:id', authenticateOrApiKey, ctrl.updateRun);
router.delete('/runs/:id', authenticateOrApiKey, ctrl.deleteRun);

module.exports = router;
