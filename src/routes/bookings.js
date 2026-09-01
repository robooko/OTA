const router = require('express').Router();
const ctrl = require('../controllers/bookings');
const folio = require('../controllers/folio');
const { authenticate, authenticateOrApiKey } = require('../middleware/auth');

router.get('/', authenticateOrApiKey, ctrl.listBookings);
router.get('/:id', authenticateOrApiKey, ctrl.getBooking);
router.post('/', authenticateOrApiKey, ctrl.createBooking);
router.put('/:id', authenticate, ctrl.updateBooking);
router.delete('/:id', authenticateOrApiKey, ctrl.cancelBooking);

// Guest folio (see docs/superpowers/specs/2026-09-01-guest-folio-design.md)
router.get('/:id/folio', authenticate, folio.getFolio);
router.post('/:id/folio/adjustments', authenticate, folio.addAdjustment);
router.delete('/:id/folio/adjustments/:adjustment_id', authenticate, folio.removeAdjustment);

module.exports = router;
