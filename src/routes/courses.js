const router = require('express').Router();
const ctrl = require('../controllers/courses');
const { authenticateOrApiKey } = require('../middleware/auth');
const { isValidUuid } = require('../middleware/validate');

// Every :id here is a row UUID; anything else can't exist, and would
// otherwise reach Postgres as a cast error (500).
router.param('id', (req, res, next, id) => (isValidUuid(id) ? next() : res.status(404).json({ error: 'Not found' })));

// Enrolments
router.get('/enrolments', authenticateOrApiKey, ctrl.listEnrolments);
router.post('/enrolments', authenticateOrApiKey, ctrl.createEnrolment);
router.put('/enrolments/:id', authenticateOrApiKey, ctrl.updateEnrolment);

// Courses
router.get('/', authenticateOrApiKey, ctrl.listCourses);
router.post('/', authenticateOrApiKey, ctrl.createCourse);
router.put('/:id', authenticateOrApiKey, ctrl.updateCourse);
router.delete('/:id', authenticateOrApiKey, ctrl.deleteCourse);

// Runs
router.post('/:id/runs', authenticateOrApiKey, ctrl.createRuns);
router.get('/runs/search', authenticateOrApiKey, ctrl.searchRuns);
router.get('/runs/:id/roster', authenticateOrApiKey, ctrl.getRoster);
router.put('/runs/:id', authenticateOrApiKey, ctrl.updateRun);
router.delete('/runs/:id', authenticateOrApiKey, ctrl.deleteRun);

module.exports = router;
